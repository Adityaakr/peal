//! bte-node: operator binary. Outbound only, stateless beyond its keystores,
//! safe to restart at any point, never logs secrets.
//!
//! Two kinds of committee, either or both:
//! - v0 (`--operator-id` + `--key`): polls /v0/work for the dealt committee
//!   and posts one 48-byte share per frozen batch.
//! - v1 (`--identity` + `--state-dir`): takes part in every DKG round the
//!   coordinator's relay names it in, keeps the resulting share encrypted in
//!   the state directory, and posts one share per frozen batch of every v1
//!   committee it holds a share of.

use anyhow::{bail, Context, Result};
use base64::Engine;
use bte_crypto::tbte;
use bte_crypto::wire::header_from_bytes;
use bte_crypto::{partial, CtHeader, OperatorSecret, Share};
use bte_node::dkg_client::{Progress, Relay, RoundDriver};
use bte_node::identity::{self, OperatorIdentity};
use bte_node::keystore;
use bte_node::v1store::{self, HeldCommittee};
use clap::Parser;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tracing::{info, warn};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Parser)]
#[command(name = "bte-node", about = "bte operator node")]
struct Cli {
    /// TOML config file ([node] operator_id, coordinator_url, key_path,
    /// identity_path, state_dir).
    #[arg(long)]
    config: Option<std::path::PathBuf>,
    /// v0: this operator's 1-based index in the dealt committee.
    #[arg(long)]
    operator_id: Option<u16>,
    #[arg(long)]
    coordinator: Option<String>,
    /// v0: the dealt keystore.
    #[arg(long)]
    key: Option<std::path::PathBuf>,
    /// v1: the operator identity file (`bte-cli identity new`).
    #[arg(long)]
    identity: Option<std::path::PathBuf>,
    /// v1: where committee shares are kept (default: beside the identity).
    #[arg(long)]
    state_dir: Option<std::path::PathBuf>,
    /// Poll interval in milliseconds.
    #[arg(long, default_value_t = 2000)]
    poll_ms: u64,
    /// Post a random invalid share instead of an honest one. Refuses to run
    /// unless BTE_DEV=1.
    #[arg(long, default_value_t = false)]
    byzantine: bool,
}

#[derive(Deserialize, Default)]
struct FileConfig {
    node: Option<NodeSection>,
}

#[derive(Deserialize, Default)]
struct NodeSection {
    operator_id: Option<u16>,
    coordinator_url: Option<String>,
    key_path: Option<String>,
    identity_path: Option<String>,
    state_dir: Option<String>,
}

struct Config {
    operator_id: Option<u16>,
    coordinator: String,
    key_path: Option<std::path::PathBuf>,
    identity_path: Option<std::path::PathBuf>,
    state_dir: Option<std::path::PathBuf>,
    poll_ms: u64,
    byzantine: bool,
}

fn load_config(cli: Cli) -> Result<Config> {
    let file: FileConfig = match &cli.config {
        Some(path) => toml::from_str(&std::fs::read_to_string(path)?)?,
        None => FileConfig::default(),
    };
    let section = file.node.unwrap_or_default();
    let env_u16 = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u16>().ok());
    let env_path = |k: &str| std::env::var(k).ok().map(std::path::PathBuf::from);
    let key_path = cli
        .key
        .or(section.key_path.map(Into::into))
        .or(env_path("BTE_KEY_PATH"))
        .or_else(|| {
            // Unused when BTE_KEYSTORE_JSON is set; validated at open time.
            std::env::var("BTE_KEYSTORE_JSON")
                .ok()
                .map(|_| std::path::PathBuf::from("/ceremony/operator.keystore"))
        });
    let operator_id = cli
        .operator_id
        .or(section.operator_id)
        .or(env_u16("BTE_OPERATOR_ID"));
    let identity_path = cli
        .identity
        .or(section.identity_path.map(Into::into))
        .or(env_path("BTE_IDENTITY_PATH"));
    if operator_id.is_none() && identity_path.is_none() {
        bail!("nothing to run: give --operator-id/--key for a v0 committee, --identity for v1, or both");
    }
    if operator_id.is_some() && key_path.is_none() {
        bail!("--operator-id needs --key (or BTE_KEY_PATH / BTE_KEYSTORE_JSON)");
    }
    Ok(Config {
        operator_id,
        coordinator: cli
            .coordinator
            .or(section.coordinator_url)
            .or(std::env::var("BTE_COORDINATOR_URL").ok())
            .context("coordinator url required (flag, config, or BTE_COORDINATOR_URL)")?,
        key_path,
        state_dir: cli
            .state_dir
            .or(section.state_dir.map(Into::into))
            .or(env_path("BTE_STATE_DIR")),
        identity_path,
        poll_ms: cli.poll_ms,
        byzantine: cli.byzantine,
    })
}

#[derive(Deserialize)]
struct WorkBatch {
    batch_id: i64,
    condition_id: String,
    #[serde(default)]
    committee_id: String,
    #[serde(default = "default_scheme")]
    scheme: String,
    headers_b64: String,
}

fn default_scheme() -> String {
    "v0".into()
}

#[derive(Deserialize)]
struct WorkResponse {
    batches: Vec<WorkBatch>,
}

/// The v1 side of a node: its identity and the committees it holds.
struct V1Node {
    me: OperatorIdentity,
    state_dir: std::path::PathBuf,
    passphrase: String,
    held: Vec<HeldCommittee>,
    rounds: HashMap<String, RoundDriver>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = load_config(Cli::parse())?;
    if cfg.byzantine && std::env::var("BTE_DEV").ok().as_deref() != Some("1") {
        bail!("--byzantine is a dev/testing flag; refusing to start without BTE_DEV=1");
    }
    let passphrase = std::env::var("BTE_KEYSTORE_PASS")
        .context("BTE_KEYSTORE_PASS required to open the keystores")?;

    // v0: the dealt share.
    let v0 = match cfg.operator_id {
        Some(operator_id) => {
            // Cloud deploys without shared volumes can inject the (encrypted)
            // keystore JSON directly via env instead of a file path.
            let ks = match std::env::var("BTE_KEYSTORE_JSON") {
                Ok(json) => serde_json::from_str(&json)
                    .context("BTE_KEYSTORE_JSON is not valid keystore JSON")?,
                Err(_) => keystore::read_keystore(cfg.key_path.as_ref().expect("checked"))?,
            };
            let secret = keystore::open_keystore(&ks, &passphrase)?;
            if secret.party_index != operator_id {
                bail!(
                    "keystore is for operator {}, node configured as {}",
                    secret.party_index,
                    operator_id
                );
            }
            Some((operator_id, secret))
        }
        None => None,
    };

    // v1: the identity and every share already held.
    let mut v1 = match &cfg.identity_path {
        Some(path) => {
            let file = identity::read_identity(path)?;
            let me = OperatorIdentity::open(&file, &passphrase)?;
            let state_dir = cfg
                .state_dir
                .clone()
                .or_else(|| path.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| std::path::PathBuf::from("."));
            std::fs::create_dir_all(&state_dir)?;
            let held = v1store::load_all(&state_dir, &passphrase)?;
            info!(
                identity = me.key_hex(),
                committees = held.len(),
                state_dir = %state_dir.display(),
                "v1 identity loaded"
            );
            Some(V1Node {
                me,
                state_dir,
                passphrase: passphrase.clone(),
                held,
                rounds: HashMap::new(),
            })
        }
        None => None,
    };

    info!(
        v0_operator = v0.as_ref().map(|(id, _)| *id),
        v1 = v1.is_some(),
        coordinator = cfg.coordinator,
        byzantine = cfg.byzantine,
        "bte-node up"
    );

    let client = reqwest::Client::new();
    let relay = Relay::new(cfg.coordinator.clone());
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(cfg.poll_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if let Some((operator_id, secret)) = &v0 {
            if let Err(e) = poll_v0(&client, &cfg, *operator_id, secret).await {
                warn!(error = %e, "v0 poll failed; retrying next tick");
            }
        }
        if let Some(node) = v1.as_mut() {
            if let Err(e) = poll_dkg(node, &relay).await {
                warn!(error = %e, "dkg poll failed; retrying next tick");
            }
            if let Err(e) = poll_v1(&client, &cfg, node).await {
                warn!(error = %e, "v1 poll failed; retrying next tick");
            }
        }
    }
}

async fn fetch_work(client: &reqwest::Client, cfg: &Config, operator: u16) -> Result<WorkResponse> {
    Ok(client
        .get(format!("{}/v0/work", cfg.coordinator))
        .query(&[("operator", operator)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

async fn post_share(
    client: &reqwest::Client,
    cfg: &Config,
    batch: &WorkBatch,
    operator: u16,
    share_bytes: &[u8],
    started: std::time::Instant,
) -> Result<()> {
    let share_hash = hex::encode(&Sha256::digest(share_bytes)[..8]);
    let resp: serde_json::Value = client
        .post(format!("{}/v0/shares", cfg.coordinator))
        .json(&serde_json::json!({
            "batch_id": batch.batch_id,
            "operator_id": operator,
            "share_b64": B64.encode(share_bytes),
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    info!(
        batch_id = batch.batch_id,
        condition_id = batch.condition_id,
        scheme = batch.scheme,
        partial_ms = started.elapsed().as_millis() as u64,
        share_hash,
        verified = resp["verified"].as_bool().unwrap_or(false),
        byzantine = cfg.byzantine,
        "share submitted"
    );
    Ok(())
}

async fn poll_v0(
    client: &reqwest::Client,
    cfg: &Config,
    operator_id: u16,
    secret: &OperatorSecret,
) -> Result<()> {
    let work = fetch_work(client, cfg, operator_id).await?;
    for batch in work.batches.iter().filter(|b| b.scheme == "v0") {
        let started = std::time::Instant::now();
        let headers_raw = B64
            .decode(&batch.headers_b64)
            .context("work headers are not valid base64")?;
        if !headers_raw.len().is_multiple_of(48) {
            bail!("work headers are not a multiple of 48 bytes");
        }
        let headers: Vec<CtHeader> = headers_raw
            .chunks(48)
            .map(header_from_bytes)
            .collect::<Result<_, _>>()
            .map_err(|e| anyhow::anyhow!("bad header in batch {}: {e}", batch.batch_id))?;
        let share = if cfg.byzantine {
            random_invalid_share(operator_id)
        } else {
            partial(secret, &headers).map_err(|e| anyhow::anyhow!("partial failed: {e}"))?
        };
        post_share(client, cfg, batch, operator_id, &share.to_bytes(), started).await?;
    }
    Ok(())
}

/// v1 work: one poll per held committee, filtered to that committee's batches.
async fn poll_v1(client: &reqwest::Client, cfg: &Config, node: &V1Node) -> Result<()> {
    for held in &node.held {
        let work = fetch_work(client, cfg, held.party_index).await?;
        for batch in work
            .batches
            .iter()
            .filter(|b| b.scheme == "v1" && b.committee_id == held.committee_id)
        {
            let started = std::time::Instant::now();
            let headers_raw = B64
                .decode(&batch.headers_b64)
                .context("work headers are not valid base64")?;
            let headers = tbte::wire::unpack_headers(&headers_raw)
                .map_err(|e| anyhow::anyhow!("bad v1 headers in batch {}: {e}", batch.batch_id))?;
            let share = if cfg.byzantine {
                random_invalid_v1_share(held.party_index)
            } else {
                tbte::partial(&held.params, &held.secret, &headers)
                    .map_err(|e| anyhow::anyhow!("partial failed: {e}"))?
            };
            post_share(
                client,
                cfg,
                batch,
                held.party_index,
                &share.to_bytes(),
                started,
            )
            .await?;
        }
    }
    Ok(())
}

/// DKG: pick up every round the relay names us in, drive it, and keep the
/// share once it settles.
async fn poll_dkg(node: &mut V1Node, relay: &Relay) -> Result<()> {
    let rounds = relay.rounds_for(&node.me.key_hex()).await?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;
    for info in rounds {
        if info.status == "failed" {
            continue;
        }
        if let Some(committee_id) = &info.committee_id {
            if node.held.iter().any(|h| &h.committee_id == committee_id) {
                continue; // settled and already ours
            }
        }
        if !node.rounds.contains_key(&info.id) {
            info!(
                round = info.id,
                tag = info.committee_tag,
                status = info.status,
                "joining dkg round"
            );
            node.rounds
                .insert(info.id.clone(), RoundDriver::new(&node.me, info.clone())?);
        }
        let driver = node.rounds.get_mut(&info.id).expect("inserted");
        match driver.step(&node.me, relay, now).await? {
            Progress::Done => {
                let result = driver.result.as_ref().expect("done carries a result");
                let secret = result
                    .secret
                    .as_ref()
                    .context("player result without a share")?;
                let committee_id = hex::encode(result.params.digest());
                let file =
                    v1store::seal_share(&committee_id, &result.params, secret, &node.passphrase)?;
                let path = v1store::share_path(&node.state_dir, &committee_id);
                v1store::write_share(&path, &file)?;
                let held = v1store::open_share(&file, &node.passphrase)?;
                info!(
                    round = info.id,
                    committee = committee_id,
                    party_index = held.party_index,
                    path = %path.display(),
                    "dkg complete, share stored"
                );
                node.held.push(held);
                node.rounds.remove(&info.id);
            }
            Progress::Failed(reason) => {
                warn!(round = info.id, reason, "dkg round failed");
                node.rounds.remove(&info.id);
            }
            Progress::Working | Progress::LogPosted => {}
        }
    }
    Ok(())
}

/// A wire-valid but cryptographically wrong share: a random G1 point.
fn random_invalid_share(operator_id: u16) -> Share {
    Share {
        party_index: operator_id,
        value: random_point(),
    }
}

fn random_invalid_v1_share(party_index: u16) -> tbte::Share {
    tbte::Share {
        party_index,
        value: random_point(),
    }
}

fn random_point() -> ark_bls12_381::G1Affine {
    use ark_ec::{CurveGroup, PrimeGroup};
    use bte_crypto::rand::Rng;
    let mut rng = bte_crypto::os_rng();
    let k = ark_bls12_381::Fr::from(rng.gen::<u64>());
    (ark_bls12_381::G1Projective::generator() * k).into_affine()
}
