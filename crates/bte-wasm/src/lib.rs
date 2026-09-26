//! wasm bindings for bte-crypto. Seal-only by default (what browsers need);
//! the `verify` feature adds public share verification for bte-sdk/verify.
//!
//! Both schemes are served: v0 (simple-bte, `BTE0`) and v1 (transparent
//! setup from a DKG, `BTE1`). The params blob says which; every call
//! dispatches on it.

use bte_crypto::tbte;
use bte_crypto::{PublicParams, SealedCiphertext};
use wasm_bindgen::prelude::*;

enum Inner {
    V0(Box<PublicParams>),
    V1(tbte::PublicParams),
}

/// Parsed committee params held in wasm memory. Parsing subgroup-checks every
/// point, so construct once and reuse.
#[wasm_bindgen]
pub struct Params {
    inner: Inner,
}

#[derive(serde::Serialize)]
struct ParamsInfo {
    /// "v0" or "v1".
    scheme: &'static str,
    n: u16,
    t: u16,
    /// v0: the fixed batch size. v1: the batch stride (one batch per
    /// condition, at most b - 1 ciphertexts plus one decoy).
    b: u32,
    digest: String,
    /// v1 only: the DKG output digest the key came from.
    setup_digest: Option<String>,
}

#[wasm_bindgen]
impl Params {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<Params, JsError> {
        let inner = match bytes.get(..4) {
            Some(b"BTE0") => Inner::V0(Box::new(
                PublicParams::from_bytes(bytes)
                    .map_err(|e| JsError::new(&format!("invalid params: {e}")))?,
            )),
            Some(b"BTE1") => Inner::V1(
                tbte::PublicParams::from_bytes(bytes)
                    .map_err(|e| JsError::new(&format!("invalid params: {e}")))?,
            ),
            _ => return Err(JsError::new("invalid params: unknown magic")),
        };
        Ok(Params { inner })
    }

    /// {scheme, n, t, b, digest, setup_digest}
    pub fn info(&self) -> Result<JsValue, JsError> {
        let info = match &self.inner {
            Inner::V0(p) => ParamsInfo {
                scheme: "v0",
                n: p.n,
                t: p.t,
                b: p.b,
                digest: hex::encode(p.digest()),
                setup_digest: None,
            },
            Inner::V1(p) => ParamsInfo {
                scheme: "v1",
                n: p.n(),
                t: p.t(),
                b: tbte::MAX_BATCH_SLOTS as u32,
                digest: hex::encode(p.digest()),
                setup_digest: Some(hex::encode(p.setup_digest())),
            },
        };
        serde_wasm_bindgen::to_value(&info).map_err(|e| JsError::new(&e.to_string()))
    }

    /// The scheme these params run: "v0" or "v1".
    pub fn scheme(&self) -> String {
        match &self.inner {
            Inner::V0(_) => "v0".into(),
            Inner::V1(_) => "v1".into(),
        }
    }

    /// Seal a payload (up to MAX_PAYLOAD_BYTES) for a condition. Returns wire
    /// bytes to post to the coordinator. v1 ciphertexts commit to the
    /// condition (the coordinator refuses one submitted elsewhere); v0 ones
    /// ignore it. Randomness comes from the platform (getrandom js).
    pub fn seal_for(&self, condition_id: &str, payload: &[u8]) -> Result<Vec<u8>, JsError> {
        let mut rng = bte_crypto::os_rng();
        match &self.inner {
            Inner::V0(p) => bte_crypto::seal(p, payload, &mut rng)
                .map(|ct| ct.to_bytes())
                .map_err(|e| JsError::new(&format!("seal failed: {e}"))),
            Inner::V1(p) => {
                tbte::seal(p, &tbte::condition_context(condition_id), payload, &mut rng)
                    .map(|ct| ct.to_bytes())
                    .map_err(|e| JsError::new(&format!("seal failed: {e}")))
            }
        }
    }

    /// v0 only: seal without a condition. A v1 committee needs `seal_for`.
    pub fn seal(&self, payload: &[u8]) -> Result<Vec<u8>, JsError> {
        match &self.inner {
            Inner::V0(_) => self.seal_for("", payload),
            Inner::V1(_) => Err(JsError::new(
                "a v1 committee binds every ciphertext to its condition: use seal_for(condition_id, payload)",
            )),
        }
    }
}

/// Content address (hex sha256) of a sealed ciphertext's wire bytes.
#[wasm_bindgen]
pub fn ct_hash(sealed: &[u8]) -> Result<String, JsError> {
    match sealed.get(..4) {
        Some(b"BTE0") => SealedCiphertext::from_bytes(sealed)
            .map(|ct| hex::encode(ct.hash()))
            .map_err(|e| JsError::new(&format!("invalid sealed ciphertext: {e}"))),
        Some(b"BTE1") => tbte::Ciphertext::from_bytes(sealed)
            .map(|ct| hex::encode(ct.hash()))
            .map_err(|e| JsError::new(&format!("invalid sealed ciphertext: {e}"))),
        _ => Err(JsError::new("invalid sealed ciphertext: unknown magic")),
    }
}

#[cfg(feature = "verify")]
mod verify {
    use super::*;
    use bte_crypto::wire::header_from_bytes;
    use bte_crypto::{CtHeader, Share};

    /// Verify one operator's share against a frozen batch, by scheme.
    /// `headers` is the packed header blob from /v0/work or /v0/reveals
    /// (v0: B * 48-byte points; v1: framed 325-byte headers); `share_bytes`
    /// is the share's wire bytes.
    #[wasm_bindgen]
    pub fn verify_share(
        params: &Params,
        headers: &[u8],
        share_bytes: &[u8],
    ) -> Result<bool, JsError> {
        match &params.inner {
            Inner::V0(p) => {
                if !headers.len().is_multiple_of(48) {
                    return Err(JsError::new("v0 headers must be a multiple of 48 bytes"));
                }
                let headers: Vec<CtHeader> = headers
                    .chunks(48)
                    .map(header_from_bytes)
                    .collect::<Result<_, _>>()
                    .map_err(|e| JsError::new(&format!("bad header: {e}")))?;
                let share = Share::from_bytes(share_bytes)
                    .map_err(|e| JsError::new(&format!("bad share: {e}")))?;
                Ok(bte_crypto::verify_share(p, &headers, &share))
            }
            Inner::V1(p) => {
                let headers = tbte::wire::unpack_headers(headers)
                    .map_err(|e| JsError::new(&format!("bad v1 headers: {e}")))?;
                let share = tbte::Share::from_bytes(share_bytes)
                    .map_err(|e| JsError::new(&format!("bad share: {e}")))?;
                Ok(tbte::verify_share(p, &headers, &share))
            }
        }
    }
}
