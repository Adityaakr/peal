//! A minimal JSON-RPC client for the backing chains, and the ABI shapes of
//! the gateway events the watcher reads. Raw `reqwest` calls rather than a
//! chain library: the node needs six methods and nothing else.

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone)]
pub struct Rpc {
    url: String,
    http: reqwest::Client,
}

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    #[error("rpc transport: {0}")]
    Transport(String),
    #[error("rpc error {code}: {message}")]
    Remote { code: i64, message: String },
    #[error("rpc decode: {0}")]
    Decode(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct Log {
    pub address: String,
    pub topics: Vec<String>,
    pub data: String,
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    #[serde(rename = "blockHash")]
    pub block_hash: String,
    #[serde(rename = "transactionHash")]
    pub transaction_hash: String,
    #[serde(rename = "logIndex")]
    pub log_index: String,
    #[serde(default)]
    pub removed: bool,
}

pub fn keccak_topic(signature: &str) -> String {
    use sha3::{Digest, Keccak256};
    format!("0x{}", hex::encode(Keccak256::digest(signature.as_bytes())))
}

pub fn deposit_topic() -> String {
    keccak_topic("Deposit(uint256,address,address,uint256,bytes32)")
}

pub fn withdrawn_topic() -> String {
    keccak_topic("Withdrawn(bytes32,address,address,uint256,uint64)")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepositEvent {
    pub id: u128,
    pub token: String,
    pub from: String,
    pub amount: u128,
    /// The 32-byte receipt commitment exactly as the depositor passed it:
    /// the ledger's canonical field-element encoding, carried as bytes32.
    pub receipt_hex: String,
    pub block_number: u64,
    pub block_hash: String,
    pub tx_hash: String,
    pub log_index: u64,
}

impl DepositEvent {
    pub fn deposit_id(&self, chain_id: u64) -> String {
        format!("{chain_id}:{}:{}", self.tx_hash, self.log_index)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithdrawnEvent {
    pub withdrawal_id: String,
    pub token: String,
    pub recipient: String,
    pub amount: u128,
    pub epoch: u64,
    pub block_number: u64,
    pub tx_hash: String,
}

fn hex_to_u64(s: &str) -> Result<u64, RpcError> {
    u64::from_str_radix(s.trim_start_matches("0x"), 16)
        .map_err(|e| RpcError::Decode(format!("{s}: {e}")))
}

fn word_to_u128(word: &[u8]) -> Result<u128, RpcError> {
    if word.len() != 32 || word[..16].iter().any(|b| *b != 0) {
        return Err(RpcError::Decode("amount does not fit u128".into()));
    }
    let mut b = [0u8; 16];
    b.copy_from_slice(&word[16..]);
    Ok(u128::from_be_bytes(b))
}

fn topic_to_address(t: &str) -> Result<String, RpcError> {
    let raw = t.trim_start_matches("0x");
    if raw.len() != 64 {
        return Err(RpcError::Decode("topic length".into()));
    }
    Ok(format!("0x{}", raw[24..].to_lowercase()))
}

pub fn decode_deposit(log: &Log) -> Result<DepositEvent, RpcError> {
    if log.topics.len() != 4 {
        return Err(RpcError::Decode("deposit log topics".into()));
    }
    let data = hex::decode(log.data.trim_start_matches("0x"))
        .map_err(|e| RpcError::Decode(e.to_string()))?;
    if data.len() != 64 {
        return Err(RpcError::Decode("deposit log data".into()));
    }
    let id_bytes = hex::decode(log.topics[1].trim_start_matches("0x"))
        .map_err(|e| RpcError::Decode(e.to_string()))?;
    Ok(DepositEvent {
        id: word_to_u128(&id_bytes)?,
        token: topic_to_address(&log.topics[2])?,
        from: topic_to_address(&log.topics[3])?,
        amount: word_to_u128(&data[..32])?,
        receipt_hex: hex::encode(&data[32..]),
        block_number: hex_to_u64(&log.block_number)?,
        block_hash: log.block_hash.to_lowercase(),
        tx_hash: log.transaction_hash.to_lowercase(),
        log_index: hex_to_u64(&log.log_index)?,
    })
}

pub fn decode_withdrawn(log: &Log) -> Result<WithdrawnEvent, RpcError> {
    if log.topics.len() != 4 {
        return Err(RpcError::Decode("withdrawn log topics".into()));
    }
    let data = hex::decode(log.data.trim_start_matches("0x"))
        .map_err(|e| RpcError::Decode(e.to_string()))?;
    if data.len() != 64 {
        return Err(RpcError::Decode("withdrawn log data".into()));
    }
    Ok(WithdrawnEvent {
        withdrawal_id: log.topics[1].trim_start_matches("0x").to_lowercase(),
        token: topic_to_address(&log.topics[2])?,
        recipient: topic_to_address(&log.topics[3])?,
        amount: word_to_u128(&data[..32])?,
        epoch: word_to_u128(&data[32..])? as u64,
        block_number: hex_to_u64(&log.block_number)?,
        tx_hash: log.transaction_hash.to_lowercase(),
    })
}

impl Rpc {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let res = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|e| RpcError::Transport(e.to_string()))?;
        let v: Value = res
            .json()
            .await
            .map_err(|e| RpcError::Transport(e.to_string()))?;
        if let Some(err) = v.get("error") {
            return Err(RpcError::Remote {
                code: err.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
                message: err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
        v.get("result")
            .cloned()
            .ok_or_else(|| RpcError::Decode("no result".into()))
    }

    pub async fn chain_id(&self) -> Result<u64, RpcError> {
        let v = self.call("eth_chainId", json!([])).await?;
        hex_to_u64(v.as_str().unwrap_or(""))
    }

    pub async fn block_number(&self) -> Result<u64, RpcError> {
        let v = self.call("eth_blockNumber", json!([])).await?;
        hex_to_u64(v.as_str().unwrap_or(""))
    }

    /// Block hash by number, or None if the chain does not have it.
    pub async fn block_hash(&self, number: u64) -> Result<Option<String>, RpcError> {
        let v = self
            .call(
                "eth_getBlockByNumber",
                json!([format!("0x{number:x}"), false]),
            )
            .await?;
        Ok(v.get("hash")
            .and_then(|h| h.as_str())
            .map(|h| h.to_lowercase()))
    }

    pub async fn code(&self, address: &str) -> Result<Vec<u8>, RpcError> {
        let v = self.call("eth_getCode", json!([address, "latest"])).await?;
        hex::decode(v.as_str().unwrap_or("0x").trim_start_matches("0x"))
            .map_err(|e| RpcError::Decode(e.to_string()))
    }

    pub async fn logs(
        &self,
        address: &str,
        topic0: &str,
        from: u64,
        to: u64,
    ) -> Result<Vec<Log>, RpcError> {
        let v = self
            .call(
                "eth_getLogs",
                json!([{ "address": address, "topics": [topic0], "fromBlock": format!("0x{from:x}"), "toBlock": format!("0x{to:x}") }]),
            )
            .await?;
        serde_json::from_value(v).map_err(|e| RpcError::Decode(e.to_string()))
    }

    /// `eth_call` with raw calldata; returns the raw return data.
    pub async fn eth_call(&self, to: &str, data: &str) -> Result<Vec<u8>, RpcError> {
        let v = self
            .call("eth_call", json!([{ "to": to, "data": data }, "latest"]))
            .await?;
        hex::decode(v.as_str().unwrap_or("0x").trim_start_matches("0x"))
            .map_err(|e| RpcError::Decode(e.to_string()))
    }

    /// Logs of a mined transaction with the block it landed in, or `None`
    /// if the chain does not know the transaction.
    pub async fn transaction_logs(
        &self,
        tx_hash: &str,
    ) -> Result<Option<(u64, Vec<Log>)>, RpcError> {
        let v = self
            .call("eth_getTransactionReceipt", json!([tx_hash]))
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        let block = hex_to_u64(v.get("blockNumber").and_then(|b| b.as_str()).unwrap_or(""))?;
        let logs: Vec<Log> = serde_json::from_value(v.get("logs").cloned().unwrap_or(Value::Null))
            .map_err(|e| RpcError::Decode(e.to_string()))?;
        Ok(Some((block, logs)))
    }

    /// `epoch()` on the gateway.
    pub async fn gateway_epoch(&self, gateway: &str) -> Result<u64, RpcError> {
        let selector = &keccak_topic("epoch()")[..10];
        let out = self.eth_call(gateway, selector).await?;
        if out.len() != 32 {
            return Err(RpcError::Decode("epoch() return".into()));
        }
        Ok(word_to_u128(&out)? as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_are_the_keccak_of_the_signatures() {
        assert_eq!(deposit_topic().len(), 66);
        assert_ne!(deposit_topic(), withdrawn_topic());
    }

    #[test]
    fn decodes_a_deposit_log() {
        let log = Log {
            address: "0xabc".into(),
            topics: vec![
                deposit_topic(),
                format!("0x{:064x}", 7),
                "0x000000000000000000000000".to_string() + &"11".repeat(20),
                "0x000000000000000000000000".to_string() + &"22".repeat(20),
            ],
            data: format!("0x{:064x}{}", 5_000_000u64, "ab".repeat(32)),
            block_number: "0x10".into(),
            block_hash: "0xBEEF".into(),
            transaction_hash: "0xCAFE".into(),
            log_index: "0x2".into(),
            removed: false,
        };
        let d = decode_deposit(&log).unwrap();
        assert_eq!(d.id, 7);
        assert_eq!(d.token, format!("0x{}", "11".repeat(20)));
        assert_eq!(d.from, format!("0x{}", "22".repeat(20)));
        assert_eq!(d.amount, 5_000_000);
        assert_eq!(d.receipt_hex, "ab".repeat(32));
        assert_eq!(d.block_number, 16);
        assert_eq!(d.deposit_id(31337), "31337:0xcafe:2");
    }
}
