//! Node configuration: validated data, never inferred.
//!
//! A namespace is one asset domain. Its chain id, token, decimals and gateway
//! come from the config file and are checked against the chain by the
//! watcher before the namespace is reported as `available`; a ticker never
//! implies an address or a precision.

use std::path::{Path, PathBuf};

use peal_bonsai::account::{namespace_id, Namespace};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NamespaceConfig {
    /// Stable label the namespace id is derived from, e.g. "local-a/tUSD".
    pub label: String,
    pub chain_id: u64,
    pub chain_name: String,
    /// JSON-RPC endpoint; empty means no chain access (ledger-only).
    #[serde(default)]
    pub rpc_url: String,
    pub token_address: String,
    pub token_symbol: String,
    pub decimals: u8,
    #[serde(default)]
    pub gateway: String,
    /// Blocks after inclusion before a deposit is credited.
    #[serde(default = "default_confirmations")]
    pub confirmations: u64,
    /// `local`, `testnet` or `mainnet`.
    pub environment: String,
    /// Deposits and withdrawals enabled. Off until the watcher has verified
    /// the gateway's code hash and the token on the configured chain.
    #[serde(default)]
    pub enabled: bool,
    /// Optional explorer base URL for links.
    #[serde(default)]
    pub explorer_url: String,
    /// First block the watcher scans (the gateway's deployment block).
    #[serde(default)]
    pub start_block: u64,
}

fn default_confirmations() -> u64 {
    1
}

impl NamespaceConfig {
    pub fn id(&self) -> Namespace {
        namespace_id(&self.label)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        if self.label.is_empty() || self.label.len() > 80 {
            anyhow::bail!("namespace label must be 1 to 80 characters");
        }
        if !matches!(self.environment.as_str(), "local" | "testnet" | "mainnet") {
            anyhow::bail!("environment must be local, testnet or mainnet");
        }
        if self.decimals > 36 {
            anyhow::bail!("decimals out of range");
        }
        for (name, addr) in [
            ("token_address", &self.token_address),
            ("gateway", &self.gateway),
        ] {
            if !addr.is_empty() && !is_address(addr) {
                anyhow::bail!("{name} is not a 20-byte hex address");
            }
        }
        if self.enabled
            && (self.gateway.is_empty() || self.rpc_url.is_empty() || self.token_address.is_empty())
        {
            anyhow::bail!("an enabled namespace needs rpc_url, token_address and gateway");
        }
        Ok(())
    }
}

pub fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Replicated-ledger mode: this node is one validator of a Commonware
/// simplex set (decision 0010). Absent means the single-node ledger.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConsensusConfig {
    /// This validator's ed25519 key: a file holding the 32-byte seed in
    /// hex, written by `peal-links-node --keygen <path>` (never committed).
    pub key_file: PathBuf,
    /// Every validator's public key (hex), this one included.
    pub validators: Vec<String>,
    /// p2p listen address of this validator.
    pub listen: String,
    /// p2p address of every validator by public key (hex).
    pub peers: std::collections::HashMap<String, String>,
    #[serde(default = "default_max_block_txs")]
    pub max_block_txs: usize,
    /// How long an API call waits for its operation to be finalized.
    #[serde(default = "default_submit_ms")]
    pub submit_timeout_ms: u64,
}

fn default_max_block_txs() -> usize {
    64
}
fn default_submit_ms() -> u64 {
    30_000
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NodeConfig {
    #[serde(default = "default_listen")]
    pub listen: String,
    /// Where sqlite stores live.
    pub data_dir: PathBuf,
    /// Proving and verifying keys (`Keys::load_or_generate`).
    pub params_dir: PathBuf,
    /// Domains accepted in sign-in messages (EIP-4361 `domain`).
    pub auth_domains: Vec<String>,
    #[serde(default = "default_session_ttl")]
    pub session_ttl_secs: u64,
    /// Recent-root window W.
    #[serde(default = "default_root_window")]
    pub root_window: usize,
    pub namespaces: Vec<NamespaceConfig>,
    /// Labelled development-only mint endpoint (Phase C fixture; off unless
    /// set). Recorded as a blocker in BUILD_STATUS.md until real deposits
    /// replace it.
    #[serde(default)]
    pub dev_mint: bool,
    /// Batch window for the ledger actor, in milliseconds.
    #[serde(default = "default_batch_ms")]
    pub batch_window_ms: u64,
    #[serde(default = "default_batch_max")]
    pub batch_max: usize,
    /// Settlement committee for withdrawals. `signer_keys_file` points at a
    /// JSON array of hex private keys held by THIS process: the local
    /// single-process fixture, never a production committee. Refused with a
    /// mainnet namespace.
    #[serde(default)]
    pub signer_keys_file: Option<PathBuf>,
    #[serde(default = "default_threshold")]
    pub signer_threshold: usize,
    /// Watcher polling interval in milliseconds.
    #[serde(default = "default_watch_ms")]
    pub watch_interval_ms: u64,
    /// Validator mode (decision 0010).
    #[serde(default)]
    pub consensus: Option<ConsensusConfig>,
    /// Distributed committee: the ONE settlement key this validator holds
    /// (file with a hex private key), with `signer_addresses` listing every
    /// member. Signatures from the other members are gathered over the
    /// validator network. Requires `consensus`. Refused with a mainnet
    /// namespace: the members are still local processes on one machine.
    #[serde(default)]
    pub signer_key_file: Option<PathBuf>,
    #[serde(default)]
    pub signer_addresses: Vec<String>,
}

fn default_threshold() -> usize {
    2
}
fn default_watch_ms() -> u64 {
    1500
}

fn default_listen() -> String {
    "127.0.0.1:8790".into()
}
fn default_session_ttl() -> u64 {
    12 * 3600
}
fn default_root_window() -> usize {
    1024
}
fn default_batch_ms() -> u64 {
    25
}
fn default_batch_max() -> usize {
    64
}

impl NodeConfig {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("reading {}: {e}", path.display()))?;
        let mut cfg: Self = serde_json::from_str(&text)
            .map_err(|e| anyhow::anyhow!("parsing {}: {e}", path.display()))?;
        if cfg.namespaces.is_empty() {
            anyhow::bail!("at least one namespace is required");
        }
        let mut seen = std::collections::HashSet::new();
        for ns in &cfg.namespaces {
            ns.validate()?;
            if !seen.insert(ns.id()) {
                anyhow::bail!("duplicate namespace label {}", ns.label);
            }
        }
        if cfg.auth_domains.is_empty() {
            anyhow::bail!("auth_domains must list at least one domain");
        }
        // Environment overrides that make sense per deployment.
        if let Ok(l) = std::env::var("PEAL_LINKS_LISTEN") {
            cfg.listen = l;
        }
        if std::env::var("PEAL_LINKS_DEV_MINT")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            cfg.dev_mint = true;
        }
        let has_mainnet = cfg.namespaces.iter().any(|n| n.environment == "mainnet");
        if cfg.dev_mint && has_mainnet {
            anyhow::bail!("dev_mint cannot be enabled with a mainnet namespace configured");
        }
        if cfg.signer_keys_file.is_some() && has_mainnet {
            anyhow::bail!(
                "a single-process signer fixture cannot be used with a mainnet namespace"
            );
        }
        if cfg.signer_keys_file.is_some() && cfg.signer_key_file.is_some() {
            anyhow::bail!(
                "signer_keys_file (fixture) and signer_key_file (distributed) are exclusive"
            );
        }
        if let Some(c) = &cfg.consensus {
            if c.validators.len() < 3 {
                anyhow::bail!("consensus needs at least three validators");
            }
            for v in &c.validators {
                if !c.peers.contains_key(v) {
                    anyhow::bail!("validator {v} has no p2p address in peers");
                }
            }
            if !c.key_file.exists() {
                anyhow::bail!("consensus key file {} does not exist", c.key_file.display());
            }
        }
        if let Some(path) = &cfg.signer_key_file {
            if cfg.consensus.is_none() {
                anyhow::bail!(
                    "signer_key_file needs consensus (the committee is the validator set)"
                );
            }
            if has_mainnet {
                anyhow::bail!("local validator signers cannot be used with a mainnet namespace");
            }
            if !path.exists() {
                anyhow::bail!("signer key file {} does not exist", path.display());
            }
            if cfg.signer_addresses.len() < cfg.signer_threshold || cfg.signer_threshold == 0 {
                anyhow::bail!("signer_addresses must list at least signer_threshold members");
            }
            for a in &cfg.signer_addresses {
                if !is_address(a) {
                    anyhow::bail!("signer address {a} is not a 20-byte hex address");
                }
            }
        }
        Ok(cfg)
    }
}
