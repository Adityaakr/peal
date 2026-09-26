//! bte-cli: trusted dealer ceremony, committee registration, dev helpers.

use anyhow::{bail, Context, Result};
use base64::Engine;
use bte_crypto::{ceremony, seal, PublicParams};
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

async fn committee_init(coordinator: &str, params_path: &std::path::Path) -> Result<()> {
    let blob = std::fs::read(params_path)?;
    // Validate locally before shipping.
    let params =
        PublicParams::from_bytes(&blob).map_err(|e| anyhow::anyhow!("params file invalid: {e}"))?;
    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .post(format!("{coordinator}/v0/committees"))
        .json(&serde_json::json!({"params_b64": B64.encode(&blob)}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    println!(
        "committee registered: id={} (n={} t={} B={})",
        resp["id"].as_str().unwrap_or("?"),
        params.n,
        params.t,
        params.b
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
    let params = PublicParams::from_bytes(&params_blob)
        .map_err(|e| anyhow::anyhow!("bad params from coordinator: {e}"))?;
    println!(
        "e2e: committee {} (n={} t={} B={})",
        &committee["id"].as_str().unwrap_or("?")[..16],
        params.n,
        params.t,
        params.b
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
        let ct = seal(&params, p, &mut rng).map_err(|e| anyhow::anyhow!("seal: {e}"))?;
        client
            .post(format!("{coordinator}/v0/ciphertexts"))
            .json(&serde_json::json!({
                "condition_id": condition_id,
                "sealed_blob_b64": B64.encode(ct.to_bytes()),
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
