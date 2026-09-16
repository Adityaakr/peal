//! Validator mode (decision 0010): the node as one validator of a
//! Commonware simplex set. This module supplies the two things the
//! consensus crate leaves to the application: how a validator confirms a
//! deposit from its own chain view, and how it answers settlement
//! signature requests from its peers.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::future::BoxFuture;
use peal_bonsai::account::Namespace;
use peal_bonsai::deposit::MintEnvelope;
use peal_bonsai::encoding::fr_from_hex;
use peal_links_consensus::engine::Params;
use peal_links_consensus::validator::{self, ValidatorConfig};
use peal_links_consensus::{AppHandler, DepositOracle, Handle, PublicKey, Shared};
use tracing::{info, warn};

use crate::api::AppState;
use crate::config::{NamespaceConfig, NodeConfig};
use crate::evm::{decode_deposit, Rpc};

/// Confirms a proposed mint against this validator's own RPC: the
/// transaction exists, the log at the claimed index is a `Deposit` from
/// the namespace's gateway for its token, the amount and receipt match
/// the intent the proof was made for, and the block is `confirmations`
/// deep. A proposer's word is never enough.
pub struct ChainOracle {
    namespaces: HashMap<Namespace, NamespaceConfig>,
}

impl ChainOracle {
    pub fn new(namespaces: HashMap<Namespace, NamespaceConfig>) -> Self {
        Self { namespaces }
    }

    async fn check(ns: NamespaceConfig, env: MintEnvelope) -> Result<bool, String> {
        let mut parts = env.deposit_id.splitn(3, ':');
        let (Some(chain), Some(tx_hash), Some(log_index)) =
            (parts.next(), parts.next(), parts.next())
        else {
            return Ok(false);
        };
        if chain.parse::<u64>().ok() != Some(ns.chain_id) {
            return Ok(false);
        }
        let Ok(log_index) = log_index.parse::<u64>() else {
            return Ok(false);
        };
        if !ns.enabled || ns.rpc_url.is_empty() || ns.gateway.is_empty() {
            return Ok(false);
        }
        let rpc = Rpc::new(&ns.rpc_url);
        let head = rpc.block_number().await.map_err(|e| e.to_string())?;
        let Some((block, logs)) = rpc
            .transaction_logs(tx_hash)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(false);
        };
        if block + ns.confirmations > head {
            // Not deep enough yet from here: deny rather than guess. The
            // proposer only proposes after its own confirmations, so this
            // is a lagging RPC, and the mint is proposed again later.
            return Ok(false);
        }
        let Some(log) = logs.iter().find(|l| {
            u64::from_str_radix(l.log_index.trim_start_matches("0x"), 16).ok() == Some(log_index)
        }) else {
            return Ok(false);
        };
        if log.address.to_lowercase() != ns.gateway.to_lowercase() || log.removed {
            return Ok(false);
        }
        let Ok(ev) = decode_deposit(log) else {
            return Ok(false);
        };
        let receipt = match fr_from_hex(&ev.receipt_hex) {
            Ok(r) => r,
            Err(_) => return Ok(false),
        };
        Ok(ev.token == ns.token_address.to_lowercase()
            && ev.amount == env.intent.amount as u128
            && receipt == env.intent.receipt
            && ev.tx_hash.to_lowercase() == tx_hash.to_lowercase())
    }
}

impl DepositOracle for ChainOracle {
    fn confirmed(
        &self,
        namespace: Namespace,
        env: MintEnvelope,
    ) -> BoxFuture<'static, Result<bool, String>> {
        let ns = self.namespaces.get(&namespace).cloned();
        Box::pin(async move {
            match ns {
                Some(ns) => Self::check(ns, env).await,
                None => Ok(false),
            }
        })
    }
}

/// Answers settlement signature requests from peer validators. The
/// application state is bound after start-up (the handle it needs is
/// created by the validator this handler is given to).
#[derive(Default)]
pub struct SignerHandler {
    app: OnceLock<Arc<AppState>>,
}

impl SignerHandler {
    pub fn bind(&self, app: Arc<AppState>) {
        let _ = self.app.set(app);
    }
}

impl AppHandler for SignerHandler {
    fn handle(&self, from: PublicKey, body: Vec<u8>) -> BoxFuture<'static, Option<Vec<u8>>> {
        let app = self.app.get().cloned();
        Box::pin(async move {
            let app = app?;
            let req: crate::settlement::SignRequest = match serde_json::from_slice(&body) {
                Ok(r) => r,
                Err(e) => {
                    warn!(peer = %from, error = %e, "malformed signature request");
                    return None;
                }
            };
            let resp = crate::settlement::sign_for_peer(&app, &from.to_string(), req).await;
            serde_json::to_vec(&resp).ok()
        })
    }
}

/// Start this node's validator. Returns the handle the ledger handles and
/// the settlement code use.
pub fn start(
    cfg: &NodeConfig,
    state: Shared,
    genesis: [u8; 32],
    namespaces: HashMap<Namespace, NamespaceConfig>,
    handler: Arc<SignerHandler>,
) -> anyhow::Result<Handle> {
    let c = cfg
        .consensus
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("no consensus configuration"))?;
    let key_hex = std::fs::read_to_string(&c.key_file)?;
    let private_key = peal_links_consensus::private_key_from_hex(&key_hex)?;
    let validators = c
        .validators
        .iter()
        .map(|v| peal_links_consensus::public_key_from_hex(v))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let peers = c
        .peers
        .iter()
        .map(|(pk, addr)| {
            Ok((
                peal_links_consensus::public_key_from_hex(pk)?,
                addr.parse()
                    .map_err(|e| anyhow::anyhow!("peer address {addr}: {e}"))?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let handle = validator::start(
        ValidatorConfig {
            private_key,
            validators,
            listen: c
                .listen
                .parse()
                .map_err(|e| anyhow::anyhow!("consensus listen {}: {e}", c.listen))?,
            peers,
            storage_dir: cfg.data_dir.join("consensus"),
            genesis,
            params: Params::default(),
            max_block_txs: c.max_block_txs,
            mempool_ttl: Duration::from_secs(120),
            worker_threads: 4,
        },
        state,
        Arc::new(ChainOracle::new(namespaces)),
        handler,
    )?;
    info!(
        validator = %handle.me,
        validators = handle.validators.len(),
        listen = c.listen,
        genesis = hex::encode(genesis),
        "consensus validator started (Commonware simplex, ed25519 scheme, local validator set)"
    );
    Ok(handle)
}
