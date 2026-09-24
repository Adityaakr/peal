//! Shared application state: sqlite handle, in-memory committee cache
//! (params + rebuilt recovery keys), and pipelined cross-terms.

use anyhow::Result;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use crate::db;

pub struct Config {
    pub reveal_timeout_secs: i64,
    pub dev: bool,
    /// Bearer for operator actions (starting a DKG round). `BTE_ADMIN_TOKEN`;
    /// with `BTE_DEV=1` the check is waived.
    pub admin_token: Option<String>,
    /// Token bucket per IP: sustained requests/second and burst size.
    pub rate_rps: f64,
    pub rate_burst: f64,
    /// JSON-RPC endpoints for at_block conditions, keyed by chain id.
    /// SEPOLIA_RPC_URL maps to 11155111; BTE_RPC_URL_<chain_id> adds others.
    pub rpc_urls: std::collections::HashMap<i64, String>,
    /// Who this coordinator commits batch orderings as. Goes into every
    /// `batch_commitments` row and therefore into every receipt, so an agent
    /// can decide whether it is willing to be ordered by this operator.
    /// Configured, never derived: an executor identity nobody set is one
    /// nobody is accountable for.
    pub executor_identity: String,
}

impl Config {
    pub fn from_env() -> Config {
        let mut rpc_urls = std::collections::HashMap::new();

        // Tempo Moderato, watched by default.
        //
        // opens_at_block was documented in the meta description, the
        // introduction, the quickstart, how it works, the API reference and the
        // SDK, and every chain id answered unsupported_chain, because no RPC
        // was ever configured. The engine that watches heights and fires the
        // condition has been there the whole time; it had nothing to watch.
        //
        // Tempo is the right default rather than a new dependency: this network
        // already talks to it for the registry and for x402 settlement, so a
        // chain that was already required is now also one you can open a round
        // on. Set BTE_RPC_URL_42431 to point it somewhere else, or to an empty
        // string to stop watching it.
        rpc_urls.insert(42431, "https://rpc.moderato.tempo.xyz".to_string());

        if let Ok(url) = std::env::var("SEPOLIA_RPC_URL") {
            if !url.is_empty() {
                rpc_urls.insert(11155111, url);
            }
        }
        for (key, value) in std::env::vars() {
            if let Some(chain_id) = key.strip_prefix("BTE_RPC_URL_") {
                if let Ok(chain_id) = chain_id.parse::<i64>() {
                    // An empty value removes a chain, including a default.
                    if value.is_empty() {
                        rpc_urls.remove(&chain_id);
                    } else {
                        // An empty value removes a chain, including a default.
                        if value.is_empty() {
                            rpc_urls.remove(&chain_id);
                        } else {
                            rpc_urls.insert(chain_id, value);
                        }
                    }
                }
            }
        }
        Config {
            rpc_urls,
            executor_identity: std::env::var("PEAL_EXECUTOR_IDENTITY")
                .unwrap_or_else(|_| "unconfigured-executor".to_string()),
            reveal_timeout_secs: std::env::var("REVEAL_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(120),
            dev: std::env::var("BTE_DEV").is_ok_and(|v| v == "1"),
            admin_token: std::env::var("BTE_ADMIN_TOKEN")
                .ok()
                .filter(|t| !t.is_empty()),
            rate_rps: std::env::var("BTE_RATE_RPS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(50.0),
            rate_burst: std::env::var("BTE_RATE_BURST")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(400.0),
        }
    }
}

pub use crate::scheme::Committee;

pub struct Inner {
    pub db: Mutex<Connection>,
    pub committees: RwLock<HashMap<String, Arc<Committee>>>,
    /// batch_id -> pipelined cross-terms (recomputed after restart if absent).
    pub cross: Mutex<HashMap<i64, Arc<crate::scheme::CrossTerms>>>,
    /// Rate limiter buckets: ip -> (tokens, last_refill_ms).
    pub buckets: Mutex<HashMap<String, (f64, i64)>>,
    /// Shared HTTP client (at_block JSON-RPC polling).
    pub http: reqwest::Client,
    /// Link previews for named auctions, keyed by name. See names.rs.
    pub previews: crate::names::PreviewCache,
    pub cfg: Config,
}

#[derive(Clone)]
pub struct App(pub Arc<Inner>);

impl App {
    pub fn new(conn: Connection, cfg: Config) -> Result<App> {
        let app = App(Arc::new(Inner {
            db: Mutex::new(conn),
            committees: RwLock::new(HashMap::new()),
            cross: Mutex::new(HashMap::new()),
            buckets: Mutex::new(HashMap::new()),
            http: reqwest::Client::new(),
            previews: crate::names::PreviewCache::default(),
            cfg,
        }));
        app.load_committees()?;
        Ok(app)
    }

    /// Load registered committees from sqlite and rebuild recovery keys.
    fn load_committees(&self) -> Result<()> {
        let blobs: Vec<Vec<u8>> = {
            let conn = self.0.db.lock().unwrap();
            let mut stmt = conn.prepare("SELECT params_blob FROM committees")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for blob in blobs {
            self.cache_committee(&blob)?;
        }
        Ok(())
    }

    pub fn cache_committee(&self, params_blob: &[u8]) -> Result<String> {
        let committee = Committee::parse(params_blob)?;
        let id = hex::encode(committee.digest);
        self.0
            .committees
            .write()
            .unwrap()
            .insert(id.clone(), Arc::new(committee));
        Ok(id)
    }

    pub fn committee(&self, id: &str) -> Option<Arc<Committee>> {
        self.0.committees.read().unwrap().get(id).cloned()
    }

    /// Register a committee: persist + cache. Returns the id (digest hex).
    pub fn register_committee(&self, params_blob: &[u8]) -> Result<String> {
        let id = self.cache_committee(params_blob)?;
        let committee = self.committee(&id).expect("just cached");
        let conn = self.0.db.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO committees (id, params_blob, params_digest, n, t, b, scheme, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                params_blob,
                id,
                committee.n,
                committee.t,
                committee.b as i64,
                committee.scheme.as_str(),
                db::unix_now()
            ],
        )?;
        Ok(id)
    }
}

pub fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 12];
    use bte_crypto::rand::Rng;
    bte_crypto::os_rng().fill(&mut bytes);
    format!("{prefix}_{}", hex::encode(bytes))
}

/// Short share-link code: 8 random bytes as 11 base64url chars (no padding).
///
/// 64 bits, server-issued. It must NOT be derived from the ciphertext: a code
/// the sender can influence is grindable (ct_hash is sha256 over the wire and
/// submit-time validation leaves ct1/ct2 free), which would let a sender point
/// one link at two different seals. Random and server-chosen has nothing to
/// grind and nothing to squat.
pub fn new_share_code() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 8];
    use bte_crypto::rand::Rng;
    bte_crypto::os_rng().fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
