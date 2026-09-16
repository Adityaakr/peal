//! peal-links-node: the Bonsai ledger, request API and inbox for Peal Links.
//!
//! Usage: `peal-links-node --config config/peal-links.local.json`

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use peal_bonsai::ledger::{Ledger, LedgerConfig, VerifyingKeys};
use peal_bonsai::params::{pk_to_bytes, vk_to_bytes, Instance, Keys};
use peal_links_node::api::{self, AppState, ParamFile};
use peal_links_node::config::NodeConfig;
use peal_links_node::ledger_actor::LedgerHandle;
use peal_links_node::product;
use sha2::{Digest, Sha256};
use tracing::info;

fn commonware_public_key(key: &peal_links_consensus::PrivateKey) -> String {
    use commonware_cryptography::Signer;
    key.public_key().to_string()
}

/// Run `f` with tracing spans disabled on this thread (arkworks emits one
/// per constraint operation).
fn quiet<T>(f: impl FnOnce() -> T) -> T {
    tracing::subscriber::with_default(tracing::subscriber::NoSubscriber::default(), f)
}

#[tokio::main]
async fn main() -> Result<()> {
    // arkworks opens a tracing span per constraint-system operation. With a
    // global subscriber installed, key generation and proving would spend
    // their time in `new_span`, so those crates are switched off at the
    // filter (static directives, so the callsites are cached as never
    // enabled) and the CPU-heavy paths additionally run under a
    // thread-local no-op subscriber (see `quiet` below and ledger_actor.rs).
    let default_filter = "info,ark_r1cs_std=off,ark_relations=off,ark_crypto_primitives=off,\
                          ark_ff=off,ark_ec=off,ark_poly=off,zkpari=off";
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default_filter)),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    // `--keygen <path>`: write a fresh validator key (hex seed, 0600) and
    // print its public key, then exit. Used by the stack script.
    if let Some(i) = args.iter().position(|a| a == "--keygen") {
        let path = args
            .get(i + 1)
            .ok_or_else(|| anyhow::anyhow!("--keygen needs a path"))?;
        let path = std::path::Path::new(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let seed = peal_links_consensus::generate_private_key_hex();
        std::fs::write(path, &seed)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        let key = peal_links_consensus::private_key_from_hex(&seed)?;
        println!("{}", commonware_public_key(&key));
        return Ok(());
    }
    let config_path = args
        .iter()
        .position(|a| a == "--config")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .or_else(|| std::env::var("PEAL_LINKS_CONFIG").ok())
        .unwrap_or_else(|| "config/peal-links.local.json".to_string());
    let cfg = NodeConfig::load(std::path::Path::new(&config_path))?;
    std::fs::create_dir_all(&cfg.data_dir).context("data dir")?;

    let inst = Instance::default_instance();
    let started = std::time::Instant::now();
    let keys = quiet(|| Keys::load_or_generate(&inst, &cfg.params_dir))
        .map_err(|e| anyhow::anyhow!("params: {e}"))?;
    info!(
        circuit_id = hex::encode(keys.circuit_id),
        ms = started.elapsed().as_millis() as u64,
        params_dir = %cfg.params_dir.display(),
        "proving material ready (local development setup, no ceremony)"
    );

    let mut params = HashMap::new();
    for (name, bytes) in [
        ("op.pk", pk_to_bytes(&keys.op.pk)),
        ("op.vk", vk_to_bytes(&keys.op.vk)),
        ("deposit.pk", pk_to_bytes(&keys.deposit.pk)),
        ("deposit.vk", vk_to_bytes(&keys.deposit.vk)),
    ] {
        let digest = hex::encode(Sha256::digest(&bytes));
        info!(file = name, bytes = bytes.len(), digest, "parameter file");
        params.insert(name, ParamFile { bytes, digest });
    }

    let mut opened = HashMap::new();
    let mut namespaces = HashMap::new();
    for ns in &cfg.namespaces {
        let id = ns.id();
        let path = cfg
            .data_dir
            .join(format!("ledger-{}.sqlite", &hex::encode(id)[..16]));
        let ledger = Ledger::open(
            &path,
            inst.clone(),
            VerifyingKeys::from(&keys),
            LedgerConfig {
                namespace: id,
                circuit_id: keys.circuit_id,
                root_window: cfg.root_window,
            },
        )
        .map_err(|e| anyhow::anyhow!("opening ledger {}: {e}", ns.label))?;
        info!(namespace = ns.label, seq = ledger.seq(), receipts = ledger.receipt_count(), path = %path.display(), "ledger open");
        opened.insert(id, ledger);
        namespaces.insert(id, ns.clone());
    }

    // Single-node: one actor thread per ledger. Validator mode: every
    // ledger joins the replicated state and writes go through consensus.
    let signer_handler = Arc::new(peal_links_node::consensus::SignerHandler::default());
    let mut ledgers = HashMap::new();
    let mut consensus = None;
    if cfg.consensus.is_some() {
        let ids: Vec<_> = opened.keys().copied().collect();
        let genesis = peal_links_consensus::genesis(&keys.circuit_id, &ids);
        let state = peal_links_consensus::State::open(
            opened,
            Some(&cfg.data_dir.join("consensus.sqlite")),
            genesis,
        )
        .map_err(|e| anyhow::anyhow!("consensus state: {e}"))?;
        let shared: peal_links_consensus::Shared = Arc::new(Mutex::new(state));
        let handle = peal_links_node::consensus::start(
            &cfg,
            shared.clone(),
            genesis,
            namespaces.clone(),
            signer_handler.clone(),
        )?;
        let timeout = Duration::from_millis(
            cfg.consensus
                .as_ref()
                .map(|c| c.submit_timeout_ms)
                .unwrap_or(30_000),
        );
        for id in ids {
            ledgers.insert(
                id,
                LedgerHandle::replicated(id, shared.clone(), handle.clone(), timeout),
            );
        }
        consensus = Some(handle);
    } else {
        for (id, ledger) in opened {
            ledgers.insert(
                id,
                LedgerHandle::spawn(
                    ledger,
                    Duration::from_millis(cfg.batch_window_ms),
                    cfg.batch_max,
                ),
            );
        }
    }

    let product = product::open(&cfg.data_dir.join("links.sqlite")).context("product store")?;
    let committee = match (&cfg.signer_keys_file, &cfg.signer_key_file) {
        (Some(path), _) => {
            let keys: Vec<String> =
                serde_json::from_str(&std::fs::read_to_string(path).context("signer keys file")?)
                    .context("signer keys file is a JSON array of hex keys")?;
            let c =
                peal_links_node::settlement::Committee::from_config(&keys, cfg.signer_threshold)
                    .map_err(|e| anyhow::anyhow!("committee: {e}"))?;
            tracing::warn!(
                signers = ?c.addresses(),
                threshold = c.threshold(),
                "settlement committee is a SINGLE-PROCESS FIXTURE: every signer key is held by this node"
            );
            Some(c)
        }
        (None, Some(path)) => {
            let key = std::fs::read_to_string(path).context("signer key file")?;
            let c = peal_links_node::settlement::Committee::distributed(
                &key,
                &cfg.signer_addresses,
                cfg.signer_threshold,
            )
            .map_err(|e| anyhow::anyhow!("committee: {e}"))?;
            tracing::warn!(
                members = ?c.addresses(),
                threshold = c.threshold(),
                local = c.local_signer().map(|s| s.address.clone()).unwrap_or_default(),
                "settlement committee is ONE KEY PER VALIDATOR on this machine: local processes, not independent operators"
            );
            Some(c)
        }
        (None, None) => None,
    };
    let listen = cfg.listen.clone();
    let watch_interval = Duration::from_millis(cfg.watch_interval_ms);
    let enabled: Vec<_> = cfg
        .namespaces
        .iter()
        .filter(|n| n.enabled)
        .cloned()
        .collect();
    let app: api::App = Arc::new(AppState {
        cfg,
        circuit_id: keys.circuit_id,
        ledgers,
        namespaces,
        params,
        product: Mutex::new(product),
        availability: Mutex::new(HashMap::new()),
        committee,
        consensus,
    });
    signer_handler.bind(app.clone());
    for ns in enabled {
        tokio::spawn(peal_links_node::watcher::run(
            app.clone(),
            ns,
            watch_interval,
        ));
    }

    let listener = tokio::net::TcpListener::bind(&listen).await?;
    info!(%listen, "peal-links-node listening");
    axum::serve(listener, api::router(app)).await?;
    Ok(())
}
