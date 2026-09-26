//! bte-cli: v0 trusted dealer ceremony, v1 operator identities and DKG
//! rounds, committee registration, dev helpers.

use anyhow::{bail, Context, Result};
use base64::Engine;
use bte_crypto::tbte;
use bte_crypto::{ceremony, seal, PublicParams};
use bte_node::identity::{self, OperatorIdentity};
use bte_node::keystore;
use clap::{Parser, Subcommand};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

#[derive(Parser)]
#[command(name = "bte-cli", about = "bte ceremony + committee tools")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Trusted dealer ceremony (v0 trust model): generates tau in-process,
    /// Shamir-deals shares, writes public params + encrypted keystores, and
    /// destroys tau (it never leaves simple-bte's setup).
    Ceremony {
        #[arg(long, default_value_t = 5)]
        n: u16,
        #[arg(long, default_value_t = 3)]
        t: u16,
        #[arg(long, default_value_t = 64)]
        b: u32,
        #[arg(long)]
        out: std::path::PathBuf,
    },
    /// v1: a fresh operator identity (ed25519 + X25519), encrypted at rest,
    /// with the public halves printed for whoever starts the DKG round.
    IdentityNew {
        #[arg(long)]
        out: std::path::PathBuf,
    },
    /// v1: print the public halves of an identity file.
    IdentityShow {
        #[arg(long)]
        file: std::path::PathBuf,
    },
    /// v1: start a DKG round on a coordinator's relay. Each --operator is
    /// `identity_hex:box_hex:box_sig_hex` as printed by `identity-new` /
    /// `identity-show`. Needs BTE_ADMIN_TOKEN unless the coordinator runs
    /// with BTE_DEV=1 on loopback.
    DkgInit {
        #[arg(long)]
        coordinator: String,
        #[arg(long)]
        tag: String,
        #[arg(long = "operator", required = true)]
        operators: Vec<String>,
        /// Seconds dealers wait for acknowledgements before closing.
        #[arg(long, default_value_t = 60)]
        ack_timeout_secs: i64,
        /// Block until the round settles (or fails), up to this many seconds.
        #[arg(long)]
        wait_secs: Option<u64>,
    },
    /// v1: show a DKG round.
    DkgStatus {
        #[arg(long)]
        coordinator: String,
        #[arg(long)]
        round: String,
    },
    /// Register public params with a coordinator.
    CommitteeInit {
        #[arg(long)]
        coordinator: String,
        #[arg(long)]
        params: std::path::PathBuf,
    },
    /// End-to-end smoke test against a live stack: seal -> freeze -> reveal.
    E2e {
        #[arg(long)]
        coordinator: String,
        /// Seconds until the condition fires.
        #[arg(long, default_value_t = 3)]
        in_secs: i64,
        /// Overall timeout waiting for the reveal.
        #[arg(long, default_value_t = 120)]
        timeout_secs: u64,
        /// Expect exactly this many rejected (byzantine) shares in the log.
        #[arg(long)]
        expect_rejected: Option<usize>,
        /// Minimum number of verified shares expected in the reveal log.
        #[arg(long)]
        expect_verified_at_least: Option<usize>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Ceremony { n, t, b, out } => run_ceremony(n, t, b, &out),
        Command::IdentityNew { out } => identity_new(&out),
        Command::IdentityShow { file } => identity_show(&file),
        Command::DkgInit {
            coordinator,
            tag,
            operators,
            ack_timeout_secs,
            wait_secs,
        } => dkg_init(&coordinator, &tag, &operators, ack_timeout_secs, wait_secs).await,
        Command::DkgStatus { coordinator, round } => dkg_status(&coordinator, &round).await,
        Command::CommitteeInit {
            coordinator,
            params,
        } => committee_init(&coordinator, &params).await,
        Command::E2e {
            coordinator,
            in_secs,
            timeout_secs,
            expect_rejected,
            expect_verified_at_least,
        } => {
            e2e(
                &coordinator,
                in_secs,
                timeout_secs,
                expect_rejected,
                expect_verified_at_least,
            )
            .await
        }
    }
}

fn passphrase() -> Result<String> {
    std::env::var("BTE_KEYSTORE_PASS")
        .context("BTE_KEYSTORE_PASS required (keystores are encrypted at rest)")
}

fn run_ceremony(n: u16, t: u16, b: u32, out: &std::path::Path) -> Result<()> {
    let pass = passphrase()?;
    std::fs::create_dir_all(out)?;
    let mut rng = bte_crypto::os_rng();
    let (params, secrets) =
        ceremony(n, t, b, &mut rng).map_err(|e| anyhow::anyhow!("ceremony failed: {e}"))?;

    let params_path = out.join("params.bin");
    std::fs::write(&params_path, params.to_bytes())?;
    for secret in &secrets {
        let ks = keystore::seal_keystore(secret, &pass)?;
        let path = out.join(format!("operator-{}.keystore", secret.party_index));
        keystore::write_keystore(&path, &ks)?;
    }
    println!("ceremony complete: n={n} t={t} B={b}");
    println!(
        "  params:  {} ({} bytes)",
        params_path.display(),
        params.to_bytes().len()
    );
    println!("  digest:  {}", hex::encode(params.digest()));
    println!("  keystores: operator-1..{n}.keystore (encrypted; distribute securely)");
    println!("v0 trust model: this process was the trusted dealer. tau is gone.");
    Ok(())
}

fn identity_new(out: &std::path::Path) -> Result<()> {
    let pass = passphrase()?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let me = OperatorIdentity::generate();
    identity::write_identity(out, &me.seal(&pass)?)?;
    println!("identity written: {}", out.display());
    println!("  identity: {}", me.key_hex());
    println!("  box:      {}", me.box_hex());
    println!("  operator: {}", me.operator_entry());
    Ok(())
}

fn identity_show(file: &std::path::Path) -> Result<()> {
    let f = identity::read_identity(file)?;
    if f.box_sig.is_empty() {
        bail!("identity file predates box-key signatures; make a new one with identity-new");
    }
    println!("identity: {}", f.identity);
    println!("box:      {}", f.box_key);
    println!("operator: {}:{}:{}", f.identity, f.box_key, f.box_sig);
    Ok(())
}

async fn dkg_init(
    coordinator: &str,
    tag: &str,
    operators: &[String],
    ack_timeout_secs: i64,
    wait_secs: Option<u64>,
) -> Result<()> {
    let mut entries = Vec::new();
    for op in operators {
        let parts: Vec<&str> = op.split(':').collect();
        let [identity, bx, sig] = parts.as_slice() else {
            bail!("--operator must be identity_hex:box_hex:box_sig_hex (from identity-show)");
        };
        entries.push(serde_json::json!({"identity": identity, "box": bx, "box_sig": sig}));
    }
    let client = reqwest::Client::new();
    let mut req = client
        .post(format!("{coordinator}/v0/dkg/rounds"))
        .json(&serde_json::json!({
            "committee_tag": tag,
            "operators": entries,
            "ack_timeout_secs": ack_timeout_secs,
        }));
    if let Ok(token) = std::env::var("BTE_ADMIN_TOKEN") {
        req = req.header("x-bte-admin", token);
    }
    let round: serde_json::Value = req.send().await?.error_for_status()?.json().await?;
    let id = round["id"].as_str().context("no round id")?.to_string();
    println!(
        "dkg round {id}: n={} threshold={} quorum={} ack_deadline={}",
        round["n"], round["threshold"], round["quorum"], round["ack_deadline"]
    );
    let Some(wait) = wait_secs else {
        return Ok(());
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(wait);
    loop {
        let r: serde_json::Value = client
            .get(format!("{coordinator}/v0/dkg/rounds/{id}"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        match r["status"].as_str().unwrap_or("") {
            "complete" => {
                println!(
                    "dkg complete: committee {} (n={} t={})",
                    r["committee_id"].as_str().unwrap_or("?"),
                    r["n"],
                    r["threshold"]
                );
                return Ok(());
            }
            "failed" => bail!("dkg round failed: {}", r["error"]),
            _ if std::time::Instant::now() > deadline => {
                bail!("dkg round {id} did not settle in {wait}s")
            }
            _ => tokio::time::sleep(std::time::Duration::from_millis(1000)).await,
        }
    }
}

async fn dkg_status(coordinator: &str, round: &str) -> Result<()> {
    let r: serde_json::Value = reqwest::Client::new()
        .get(format!("{coordinator}/v0/dkg/rounds/{round}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    println!("{}", serde_json::to_string_pretty(&r)?);
    Ok(())
}

async fn committee_init(coordinator: &str, params_path: &std::path::Path) -> Result<()> {
    let blob = std::fs::read(params_path)?;
    // Validate locally before shipping.
    let (n, t, b) = describe_params(&blob)?;
    let client = reqwest::Client::new();
    // Registering a committee is an operator action: the coordinator wants
    // BTE_ADMIN_TOKEN unless it runs with BTE_DEV=1 on loopback.
    let mut req = client
        .post(format!("{coordinator}/v0/committees"))
        .json(&serde_json::json!({"params_b64": B64.encode(&blob)}));
    if let Ok(token) = std::env::var("BTE_ADMIN_TOKEN") {
        req = req.header("x-bte-admin", token);
    }
    let resp: serde_json::Value = req.send().await?.error_for_status()?.json().await?;
    println!(
        "committee registered: id={} (n={n} t={t} B={b})",
        resp["id"].as_str().unwrap_or("?"),
    );
    Ok(())
}

async fn e2e(
    coordinator: &str,
    in_secs: i64,
    timeout_secs: u64,
    expect_rejected: Option<usize>,
    expect_verified_at_least: Option<usize>,
) -> Result<()> {
    let client = reqwest::Client::new();

    // The committee may still be registering on a cold compose start.
    let committee: serde_json::Value = {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let resp = client
                .get(format!("{coordinator}/v0/committees/default"))
                .send()
                .await;
            match resp {
                Ok(r) if r.status().is_success() => break r.json().await?,
                _ if std::time::Instant::now() > deadline => {
                    bail!("no committee registered at {coordinator} after 60s")
                }
                _ => tokio::time::sleep(std::time::Duration::from_millis(1000)).await,
            }
        }
    };
    let params_blob = B64.decode(committee["params_b64"].as_str().context("no params")?)?;
    let keys = AnyParams::parse(&params_blob)?;
    let (n, t, b) = describe_params(&params_blob)?;
    println!(
        "e2e: committee {} scheme={} (n={n} t={t} B={b})",
        &committee["id"].as_str().unwrap_or("?")[..16],
        keys.scheme(),
    );

    let cond: serde_json::Value = client
        .post(format!("{coordinator}/v0/conditions"))
        .json(&serde_json::json!({"in_secs": in_secs}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let condition_id = cond["id"].as_str().context("no condition id")?.to_string();
    println!("e2e: condition {condition_id} fires in {in_secs}s");

    let payloads: Vec<Vec<u8>> = (0..3)
        .map(|i| format!("e2e payload {i}: sealed now, revealed on cue").into_bytes())
        .collect();
    let mut rng = bte_crypto::os_rng();
    for p in &payloads {
        let sealed = keys.seal(&condition_id, p, &mut rng)?;
        client
            .post(format!("{coordinator}/v0/ciphertexts"))
            .json(&serde_json::json!({
                "condition_id": condition_id,
                "sealed_blob_b64": B64.encode(sealed),
            }))
            .send()
            .await?
            .error_for_status()?;
    }
    println!("e2e: sealed {} payloads", payloads.len());

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let reveal: serde_json::Value = loop {
        if std::time::Instant::now() > deadline {
            bail!("timed out waiting for reveal of {condition_id}");
        }
        let resp = client
            .get(format!("{coordinator}/v0/reveals/{condition_id}"))
            .send()
            .await?;
        if resp.status().is_success() {
            break resp.json().await?;
        }
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    };

    let slots = reveal["slots"].as_array().context("no slots")?;
    let revealed: Vec<Vec<u8>> = slots
        .iter()
        .filter(|s| s["is_dummy"] == serde_json::json!(false))
        .map(|s| B64.decode(s["payload_b64"].as_str().unwrap()).unwrap())
        .collect();
    for p in &payloads {
        if !revealed.contains(p) {
            bail!(
                "payload missing from reveal: {}",
                String::from_utf8_lossy(p)
            );
        }
    }
    for s in slots {
        if s["is_dummy"] == serde_json::json!(false) && s["valid"] != serde_json::json!(true) {
            bail!("real slot marked invalid: {s}");
        }
    }
    let shares = reveal["shares"].as_array().context("no share log")?;
    let verified = shares
        .iter()
        .filter(|s| s["verified"] == serde_json::json!(true))
        .count();
    let rejected = shares
        .iter()
        .filter(|s| s["verified"] == serde_json::json!(false))
        .count();
    if let Some(expected) = expect_rejected {
        if rejected != expected {
            bail!("expected {expected} rejected shares, saw {rejected}");
        }
    }
    if let Some(min) = expect_verified_at_least {
        if verified < min {
            bail!("expected at least {min} verified shares, saw {verified}");
        }
    }
    println!(
        "e2e PASS: {} payloads revealed, {} dummies, {verified} verified / {rejected} rejected shares, merkle_root={}",
        revealed.len(),
        slots.len() - revealed.len(),
        reveal["merkle_root"].as_str().unwrap_or("?")
    );
    Ok(())
}

/// Committee parameters of either scheme, for the dev commands.
enum AnyParams {
    V0(Box<PublicParams>),
    V1(tbte::PublicParams),
}

impl AnyParams {
    fn parse(blob: &[u8]) -> Result<AnyParams> {
        match blob.get(..4) {
            Some(b"BTE0") => Ok(AnyParams::V0(Box::new(
                PublicParams::from_bytes(blob)
                    .map_err(|e| anyhow::anyhow!("params invalid: {e}"))?,
            ))),
            Some(b"BTE1") => Ok(AnyParams::V1(
                tbte::PublicParams::from_bytes(blob)
                    .map_err(|e| anyhow::anyhow!("params invalid: {e}"))?,
            )),
            _ => bail!("unknown params magic"),
        }
    }

    fn scheme(&self) -> &'static str {
        match self {
            AnyParams::V0(_) => "v0",
            AnyParams::V1(_) => "v1",
        }
    }

    fn seal(
        &self,
        condition_id: &str,
        payload: &[u8],
        rng: &mut (impl bte_crypto::rand::Rng + bte_crypto::rand::CryptoRng),
    ) -> Result<Vec<u8>> {
        Ok(match self {
            AnyParams::V0(p) => seal(p, payload, rng)
                .map_err(|e| anyhow::anyhow!("seal: {e}"))?
                .to_bytes(),
            AnyParams::V1(p) => tbte::seal(p, &tbte::condition_context(condition_id), payload, rng)
                .map_err(|e| anyhow::anyhow!("seal: {e}"))?
                .to_bytes(),
        })
    }
}

/// (n, t, B) of a params blob; B is the v1 batch stride.
fn describe_params(blob: &[u8]) -> Result<(u16, u16, u32)> {
    Ok(match AnyParams::parse(blob)? {
        AnyParams::V0(p) => (p.n, p.t, p.b),
        AnyParams::V1(p) => (p.n(), p.t(), tbte::MAX_BATCH_SLOTS as u32),
    })
}
