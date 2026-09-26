//! bte-node: operator binary. Polls /v0/work, computes one 48-byte partial
//! per frozen batch, posts it, sleeps. Stateless beyond the keystore; safe to
//! restart at any point. Never logs secrets.

use anyhow::{bail, Context, Result};
use base64::Engine;
use bte_crypto::wire::header_from_bytes;
use bte_crypto::{partial, CtHeader, OperatorSecret, Share};
use bte_node::keystore;
use clap::Parser;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Parser)]
#[command(name = "bte-node", about = "bte operator node")]
struct Cli {
    /// TOML config file ([node] operator_id, coordinator_url, key_path).
    #[arg(long)]
    config: Option<std::path::PathBuf>,
    #[arg(long)]
    operator_id: Option<u16>,
    #[arg(long)]
    coordinator: Option<String>,
    #[arg(long)]
    key: Option<std::path::PathBuf>,
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
}

struct Config {
    operator_id: u16,
    coordinator: String,
    key_path: std::path::PathBuf,
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
    Ok(Config {
        operator_id: cli
            .operator_id
            .or(section.operator_id)
            .or(env_u16("BTE_OPERATOR_ID"))
            .context("operator_id required (flag, config, or BTE_OPERATOR_ID)")?,
        coordinator: cli
            .coordinator
            .or(section.coordinator_url)
            .or(std::env::var("BTE_COORDINATOR_URL").ok())
            .context("coordinator url required (flag, config, or BTE_COORDINATOR_URL)")?,
        key_path: cli
            .key
            .or(section.key_path.map(Into::into))
            .or(std::env::var("BTE_KEY_PATH").ok().map(Into::into))
            .unwrap_or_else(|| {
                // Unused when BTE_KEYSTORE_JSON is set; validated at open time.
                std::path::PathBuf::from("/ceremony/operator.keystore")
            }),
        poll_ms: cli.poll_ms,
        byzantine: cli.byzantine,
    })
}

#[derive(Deserialize)]
struct WorkBatch {
    batch_id: i64,
    condition_id: String,
    headers_b64: String,
}

#[derive(Deserialize)]
struct WorkResponse {
    batches: Vec<WorkBatch>,
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
        .context("BTE_KEYSTORE_PASS required to open the keystore")?;
    // Cloud deploys without shared volumes can inject the (encrypted)
    // keystore JSON directly via env instead of a file path.
    let ks = match std::env::var("BTE_KEYSTORE_JSON") {
        Ok(json) => {
            serde_json::from_str(&json).context("BTE_KEYSTORE_JSON is not valid keystore JSON")?
        }
        Err(_) => keystore::read_keystore(&cfg.key_path)?,
    };
    let secret = keystore::open_keystore(&ks, &passphrase)?;
    if secret.party_index != cfg.operator_id {
        bail!(
            "keystore is for operator {}, node configured as {}",
            secret.party_index,
            cfg.operator_id
        );
    }
    info!(
        operator = cfg.operator_id,
        coordinator = cfg.coordinator,
        byzantine = cfg.byzantine,
        "bte-node up"
    );

    let client = reqwest::Client::new();
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(cfg.poll_ms));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if let Err(e) = poll_once(&client, &cfg, &secret).await {
            warn!(error = %e, "poll failed; retrying next tick");
        }
    }
}

async fn poll_once(client: &reqwest::Client, cfg: &Config, secret: &OperatorSecret) -> Result<()> {
    let work: WorkResponse = client
        .get(format!("{}/v0/work", cfg.coordinator))
        .query(&[("operator", cfg.operator_id)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    for batch in work.batches {
        let started = std::time::Instant::now();
        let headers_raw = B64
            .decode(&batch.headers_b64)
            .context("work headers are not valid base64")?;
        if headers_raw.len() % 48 != 0 {
            bail!("work headers are not a multiple of 48 bytes");
        }
        let headers: Vec<CtHeader> = headers_raw
            .chunks(48)
            .map(header_from_bytes)
            .collect::<Result<_, _>>()
            .map_err(|e| anyhow::anyhow!("bad header in batch {}: {e}", batch.batch_id))?;

        let share = if cfg.byzantine {
            random_invalid_share(cfg.operator_id)
        } else {
            partial(secret, &headers).map_err(|e| anyhow::anyhow!("partial failed: {e}"))?
        };
        let share_bytes = share.to_bytes();
        let share_hash = hex::encode(&Sha256::digest(&share_bytes)[..8]);

        let resp: serde_json::Value = client
            .post(format!("{}/v0/shares", cfg.coordinator))
            .json(&serde_json::json!({
                "batch_id": batch.batch_id,
                "operator_id": cfg.operator_id,
                "share_b64": B64.encode(&share_bytes),
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        info!(
            batch_id = batch.batch_id,
            condition_id = batch.condition_id,
            partial_ms = started.elapsed().as_millis() as u64,
            share_hash,
            verified = resp["verified"].as_bool().unwrap_or(false),
            byzantine = cfg.byzantine,
            "share submitted"
        );
    }
    Ok(())
}

/// A wire-valid but cryptographically wrong share: a random G1 point.
fn random_invalid_share(operator_id: u16) -> Share {
    use ark_ec::{CurveGroup, PrimeGroup};
    use bte_crypto::rand::Rng;
    let mut rng = bte_crypto::os_rng();
    let k = ark_bls12_381::Fr::from(rng.gen::<u64>());
    Share {
        party_index: operator_id,
        value: (ark_bls12_381::G1Projective::generator() * k).into_affine(),
    }
}
