//! A metered twin of the API, paid for with HTTP 402 on Tempo.
//!
//! WHAT THIS IS. Every route under `/v1` is mounted a second time under
//! `/v1/x402`. The two twins run the same handlers; the only difference is that
//! the second one answers 402 until it is shown a payment. Nothing about the
//! free API changes, and no endpoint moves.
//!
//! WHY IT IS NOT THE `exact` SCHEME. The x402 `exact` scheme on EVM has the
//! payer sign an EIP-3009 authorisation and the facilitator broadcast it. That
//! needs a funded server side signer, and this coordinator deliberately holds no
//! key. So the scheme here is named `tempo-transfer` rather than `exact`, and it
//! inverts who broadcasts: the payer sends the transfer itself and presents the
//! transaction hash, and the server verifies it against the chain. It is the
//! same 402 handshake and the same settlement guarantee, reached from the other
//! side. Calling it `exact` would be a lie an x402 client could act on.
//!
//! WHAT IS VERIFIED before a paid call runs:
//!   1. the hash has never been redeemed here before,
//!   2. the receipt exists and the transaction succeeded,
//!   3. it carries an ERC-20 Transfer of at least the price, in the configured
//!      asset, to the configured payee,
//!   4. the block it landed in is recent, so an unrelated historical transfer to
//!      the same payee cannot be dug up and presented as payment.
//!
//! Redemption is the INSERT, and the primary key is the transaction hash, so two
//! requests racing on one payment cannot both win.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use crate::db::unix_now;
use crate::state::App;

/// Transfer(address,address,uint256).
const TRANSFER_TOPIC: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/// How old a payment may be. Long enough to survive a slow wallet and a retry,
/// short enough that a transfer someone made yesterday is not a free call.
const MAX_AGE_SECS: i64 = 30 * 60;

/// Where payments go unless a deployment says otherwise.
///
/// Committed on purpose. An address is public by construction: it is derived
/// from a public key and appears in every transaction that touches it, so there
/// is nothing here to leak. The private key for it lives in a wallet and is not
/// in this repository, is not on the server, and is not needed by anything the
/// server does. Payments only ever move toward this address.
///
/// The reason to have a default at all is that the alternative is an
/// environment variable somebody forgets, which turns a working feature off
/// silently on the next deploy. `PEAL_X402_PAYTO` still overrides it, which is
/// what a fork or a staging environment should use.
const DEFAULT_PAY_TO: &str = "0xf8b8ef05b9f820addf7d85d165433e6c60221af5";

pub struct Config {
    /// Where payments go. Defaults to DEFAULT_PAY_TO, overridable per
    /// deployment. A malformed override turns the gateway off rather than
    /// falling back, because silently collecting to a different address than
    /// the operator configured is worse than not collecting.
    pub pay_to: String,
    pub asset: String,
    pub rpc: String,
    pub price: u128,
    pub decimals: u32,
    pub symbol: String,
    pub chain_id: u64,
    pub network: String,
    pub explorer: String,
}

impl Config {
    pub fn from_env() -> Option<Self> {
        let pay_to = std::env::var("PEAL_X402_PAYTO")
            .unwrap_or_else(|_| DEFAULT_PAY_TO.to_string())
            .to_lowercase();
        if !is_address(&pay_to) {
            tracing::warn!("PEAL_X402_PAYTO is not an 0x address, x402 gateway stays off");
            return None;
        }
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        Some(Self {
            pay_to,
            asset: env(
                "PEAL_X402_ASSET",
                "0x20c0000000000000000000000000000000000000",
            )
            .to_lowercase(),
            rpc: env("PEAL_X402_RPC", "https://rpc.moderato.tempo.xyz"),
            price: env("PEAL_X402_PRICE", "1000").parse().unwrap_or(1000),
            decimals: env("PEAL_X402_DECIMALS", "6").parse().unwrap_or(6),
            symbol: env("PEAL_X402_SYMBOL", "PathUSD"),
            chain_id: env("PEAL_X402_CHAIN_ID", "42431").parse().unwrap_or(42431),
            network: env("PEAL_X402_NETWORK", "tempo-moderato"),
            explorer: env("PEAL_X402_EXPLORER", "https://explore.testnet.tempo.xyz"),
        })
    }

    /// The price as a decimal string, for humans and for the page.
    pub fn price_display(&self) -> String {
        let scale = 10u128.pow(self.decimals);
        let whole = self.price / scale;
        let frac = self.price % scale;
        format!("{whole}.{frac:0width$}", width = self.decimals as usize)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].chars().all(|c| c.is_ascii_hexdigit())
}

fn is_tx_hash(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// An address as a 32 byte log topic: twelve zero bytes then the address.
fn topic_for(addr: &str) -> String {
    format!("0x{}{}", "0".repeat(24), &addr[2..].to_lowercase())
}

fn hex_to_u128(hex: &str) -> Option<u128> {
    let clean = hex.trim_start_matches("0x").trim_start_matches('0');
    if clean.is_empty() {
        return Some(0);
    }
    // A Transfer value wider than u128 is not a micropayment; treat it as
    // saturated rather than pretending it did not parse.
    if clean.len() > 32 {
        return Some(u128::MAX);
    }
    u128::from_str_radix(clean, 16).ok()
}

fn hex_to_i64(hex: &str) -> Option<i64> {
    i64::from_str_radix(hex.trim_start_matches("0x"), 16).ok()
}

/// The body of a 402, in the shape an x402 client expects, with `accepts`
/// carrying the one thing this server takes.
fn requirements(cfg: &Config, resource: &str) -> Value {
    json!({
        "x402Version": 1,
        "error": "payment required",
        "accepts": [{
            "scheme": "tempo-transfer",
            "network": cfg.network,
            "maxAmountRequired": cfg.price.to_string(),
            "asset": cfg.asset,
            "payTo": cfg.pay_to,
            "resource": resource,
            "description": "One metered call to the Peal API.",
            "mimeType": "application/json",
            "maxTimeoutSeconds": MAX_AGE_SECS,
            "extra": {
                "symbol": cfg.symbol,
                "decimals": cfg.decimals,
                "chainId": cfg.chain_id,
                "rpc": cfg.rpc,
                "explorer": cfg.explorer,
                "priceDisplay": format!("{} {}", cfg.price_display(), cfg.symbol),
                // How to pay, in the response itself, so a client that has never
                // seen this scheme does not need the documentation to proceed.
                "how": "Send an ERC-20 transfer of at least maxAmountRequired of `asset` to \
                        `payTo` on chain `chainId`, then retry this request with header \
                        `X-PAYMENT: base64(json({\"txHash\":\"0x...\"}))`. The transaction must \
                        be no older than maxTimeoutSeconds and each one pays for one call.",
                "fundingRpcMethod": "tempo_fundAddress"
            }
        }]
    })
}

fn problem(status: StatusCode, code: &str, detail: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/problem+json")],
        json!({
            "type": format!("https://peal.network/problems/{code}"),
            "title": detail,
            "status": status.as_u16(),
            "code": code,
            "detail": detail,
        })
        .to_string(),
    )
        .into_response()
}

/// GET /v1/x402 — what a call costs and how to pay for it, without having to
/// trigger a 402 to find out.
pub async fn price(State(app): State<App>) -> Response {
    let Some(cfg) = Config::from_env() else {
        return not_configured();
    };
    let redeemed: i64 = {
        let conn = app.0.db.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM x402_payments", [], |r| r.get(0))
            .unwrap_or(0)
    };
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        json!({
            "enabled": true,
            "paymentsRedeemed": redeemed,
            "requirements": requirements(&cfg, "/v1/x402/*"),
        })
        .to_string(),
    )
        .into_response()
}

fn not_configured() -> Response {
    problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "x402_not_configured",
        "This deployment has no valid payee, so metered calls are off. \
         The free API at /v1 is unaffected.",
    )
}

/// The middleware. Sits in front of a second mounting of the same router.
pub async fn require_payment(State(app): State<App>, req: Request<Body>, next: Next) -> Response {
    let Some(cfg) = Config::from_env() else {
        return not_configured();
    };
    // The full path, not the one the router sees.
    //
    // axum strips the nest prefix before an inner layer runs, so `req.uri()`
    // here reads `/rounds` for a request to `/v1/x402/rounds`. A 402 that names
    // the wrong resource is worse than one that names none: a client that
    // stores the quote against that key retries the wrong URL. OriginalUri is
    // the pre-nesting path, and canonical_url puts a real origin in front of it
    // without trusting x-forwarded-proto to downgrade a public host.
    let path = req
        .extensions()
        .get::<axum::extract::OriginalUri>()
        .map(|u| u.0.path().to_string())
        .unwrap_or_else(|| req.uri().path().to_string());
    let resource =
        crate::names::canonical_url(req.headers(), path.trim_start_matches('/')).unwrap_or(path);

    let Some(header_val) = req.headers().get("x-payment").and_then(|v| v.to_str().ok()) else {
        return (
            StatusCode::PAYMENT_REQUIRED,
            [(header::CONTENT_TYPE, "application/json")],
            requirements(&cfg, &resource).to_string(),
        )
            .into_response();
    };

    let tx_hash = match parse_payment(header_val) {
        Ok(h) => h,
        Err(why) => return problem(StatusCode::BAD_REQUEST, "x402_bad_payment", &why),
    };

    match verify_payment(&cfg, &tx_hash).await {
        Ok(payment) => {
            // Redeem before serving. The primary key is the decider, so a hash
            // presented twice loses the second time even under a race.
            let inserted = {
                let conn = app.0.db.lock().unwrap();
                conn.execute(
                    "INSERT INTO x402_payments (tx_hash, payer, amount, redeemed_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        tx_hash,
                        payment.payer,
                        payment.amount.to_string(),
                        unix_now()
                    ],
                )
            };
            if inserted.is_err() {
                return problem(
                    StatusCode::PAYMENT_REQUIRED,
                    "x402_already_redeemed",
                    "That payment has already paid for a call. Each transaction pays for one.",
                );
            }
            crate::activity::count(&app, "x402_paid_call");

            let mut res = next.run(req).await;
            // The receipt of what was just paid, in the shape x402 clients read.
            let receipt = {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode(
                    json!({
                        "success": true,
                        "network": cfg.network,
                        "transaction": tx_hash,
                        "payer": payment.payer,
                        "amount": payment.amount.to_string(),
                        "asset": cfg.asset,
                        "explorer": format!("{}/tx/{}", cfg.explorer, tx_hash),
                    })
                    .to_string(),
                )
            };
            if let Ok(v) = receipt.parse() {
                res.headers_mut().insert("x-payment-response", v);
            }
            // A browser reading this from a page needs it exposed by name.
            if let Ok(v) = "x-payment-response".parse() {
                res.headers_mut()
                    .insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, v);
            }
            res
        }
        Err(why) => problem(StatusCode::PAYMENT_REQUIRED, "x402_payment_invalid", &why),
    }
}

fn parse_payment(header_val: &str) -> Result<String, String> {
    use base64::Engine;
    // Accept the bare hash too. A client that skips the envelope is being
    // clear about what it means, and rejecting it teaches nothing.
    let trimmed = header_val.trim();
    if is_tx_hash(trimmed) {
        return Ok(trimmed.to_lowercase());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(trimmed))
        .map_err(|_| "X-PAYMENT is not base64 and not a transaction hash.".to_string())?;
    let text =
        String::from_utf8(decoded).map_err(|_| "X-PAYMENT did not decode to text.".to_string())?;
    let value: Value =
        serde_json::from_str(&text).map_err(|_| "X-PAYMENT did not decode to JSON.".to_string())?;
    let hash = value
        .get("txHash")
        .or_else(|| value.pointer("/payload/txHash"))
        .and_then(Value::as_str)
        .ok_or_else(|| "X-PAYMENT has no txHash.".to_string())?;
    if !is_tx_hash(hash) {
        return Err("txHash is not a 32 byte hex hash.".to_string());
    }
    Ok(hash.to_lowercase())
}

pub struct Payment {
    pub payer: String,
    pub amount: u128,
}

/// Ask the chain whether this transaction paid, and for how much.
async fn verify_payment(cfg: &Config, tx_hash: &str) -> Result<Payment, String> {
    let client = reqwest::Client::new();
    let call = |method: &'static str, params: Value| {
        let client = client.clone();
        let rpc = cfg.rpc.clone();
        async move {
            let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
            let res = client
                .post(&rpc)
                .json(&body)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .map_err(|_| "could not reach the chain to check that payment".to_string())?;
            let value: Value = res
                .json()
                .await
                .map_err(|_| "the chain returned something unreadable".to_string())?;
            Ok::<Value, String>(value)
        }
    };

    let receipt = call("eth_getTransactionReceipt", json!([tx_hash])).await?;
    let receipt = receipt
        .get("result")
        .filter(|r| !r.is_null())
        .ok_or_else(|| {
            "no receipt for that transaction yet. Wait for it to be mined and retry.".to_string()
        })?;

    if receipt.get("status").and_then(Value::as_str) != Some("0x1") {
        return Err("that transaction failed on chain, so it paid for nothing.".to_string());
    }

    let want_to = topic_for(&cfg.pay_to);
    let logs = receipt
        .get("logs")
        .and_then(Value::as_array)
        .ok_or_else(|| "that receipt has no logs, so it moved no tokens.".to_string())?;

    let mut payer = String::new();
    let mut paid: u128 = 0;
    for log in logs {
        let addr = log
            .get("address")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase();
        let topics: Vec<String> = log
            .get("topics")
            .and_then(Value::as_array)
            .map(|t| {
                t.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_lowercase)
                    .collect()
            })
            .unwrap_or_default();
        if addr != cfg.asset || topics.len() < 3 || topics[0] != TRANSFER_TOPIC {
            continue;
        }
        if topics[2] != want_to {
            continue;
        }
        // Several transfers to the payee in one transaction all count.
        paid = paid.saturating_add(
            log.get("data")
                .and_then(Value::as_str)
                .and_then(hex_to_u128)
                .unwrap_or(0),
        );
        if payer.is_empty() && topics[1].len() == 66 {
            payer = format!("0x{}", &topics[1][26..]);
        }
    }

    if paid < cfg.price {
        return Err(format!(
            "that transaction paid {paid} but a call costs {} {}. Check the asset and the payee.",
            cfg.price_display(),
            cfg.symbol
        ));
    }

    // Recency, so an old transfer to the same payee cannot be presented as new
    // payment. Checked last: it is the only step that costs a second round trip.
    let block_hex = receipt
        .get("blockNumber")
        .and_then(Value::as_str)
        .ok_or_else(|| "that receipt has no block.".to_string())?;
    let block = call("eth_getBlockByNumber", json!([block_hex, false])).await?;
    let ts = block
        .pointer("/result/timestamp")
        .and_then(Value::as_str)
        .and_then(hex_to_i64)
        .ok_or_else(|| "could not read the block time for that payment.".to_string())?;
    let age = unix_now() - ts;
    if age > MAX_AGE_SECS {
        return Err(format!(
            "that payment is {} minutes old and a payment is good for {}. Pay again.",
            age / 60,
            MAX_AGE_SECS / 60
        ));
    }

    Ok(Payment {
        payer,
        amount: paid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_pads_the_address() {
        assert_eq!(
            topic_for("0x448b58fd35ee0d57120f30b1a5846ccd6ce4ce83"),
            "0x000000000000000000000000448b58fd35ee0d57120f30b1a5846ccd6ce4ce83"
        );
    }

    #[test]
    fn reads_a_transfer_value() {
        // 0x3e8 is the 1000 units a call costs.
        assert_eq!(
            hex_to_u128("0x00000000000000000000000000000000000000000000000000000000000003e8"),
            Some(1000)
        );
        assert_eq!(hex_to_u128("0x0"), Some(0));
    }

    #[test]
    fn accepts_both_payment_envelopes() {
        use base64::Engine;
        let hash = "0x23fbfe6ec686557d753ce2924bf4585e2abcf3ca4946f0c2738aaf9c21a10e20";
        assert_eq!(parse_payment(hash).unwrap(), hash);
        let wrapped =
            base64::engine::general_purpose::STANDARD.encode(format!(r#"{{"txHash":"{hash}"}}"#));
        assert_eq!(parse_payment(&wrapped).unwrap(), hash);
        assert!(parse_payment("nonsense").is_err());
    }

    #[test]
    fn the_shipped_default_is_a_real_address() {
        // A typo in the committed default would ship the gateway switched off,
        // and the only symptom would be a 503 nobody is looking at.
        assert!(
            is_address(DEFAULT_PAY_TO),
            "DEFAULT_PAY_TO is not an address"
        );
        assert_eq!(DEFAULT_PAY_TO, DEFAULT_PAY_TO.to_lowercase());
        assert!(
            Config::from_env().is_some(),
            "gateway is off with no env set"
        );
    }

    #[test]
    fn price_reads_as_money() {
        let cfg = Config {
            pay_to: "0x0".into(),
            asset: "0x0".into(),
            rpc: String::new(),
            price: 1000,
            decimals: 6,
            symbol: "PathUSD".into(),
            chain_id: 1,
            network: "t".into(),
            explorer: String::new(),
        };
        assert_eq!(cfg.price_display(), "0.001");
    }
}
