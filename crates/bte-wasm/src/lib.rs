//! wasm bindings for bte-crypto. Seal-only by default (what browsers need);
//! the `verify` feature adds public share verification for bte-sdk/verify.

use bte_crypto::{seal, PublicParams, SealedCiphertext};
use wasm_bindgen::prelude::*;

/// Parsed committee params held in wasm memory. Parsing subgroup-checks every
/// point, so construct once and reuse.
#[wasm_bindgen]
pub struct Params {
    inner: PublicParams,
}

#[derive(serde::Serialize)]
struct ParamsInfo {
    n: u16,
    t: u16,
    b: u32,
    digest: String,
}

#[wasm_bindgen]
impl Params {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<Params, JsError> {
        let inner = PublicParams::from_bytes(bytes)
            .map_err(|e| JsError::new(&format!("invalid params: {e}")))?;
        Ok(Params { inner })
    }

    /// {n, t, b, digest}
    pub fn info(&self) -> Result<JsValue, JsError> {
        let info = ParamsInfo {
            n: self.inner.n,
            t: self.inner.t,
            b: self.inner.b,
            digest: hex::encode(self.inner.digest()),
        };
        serde_wasm_bindgen::to_value(&info).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Seal a payload (max 4096 bytes). Returns BTE_WIRE_V0 bytes to post to
    /// the coordinator. Randomness comes from the platform (getrandom js).
    pub fn seal(&self, payload: &[u8]) -> Result<Vec<u8>, JsError> {
        let mut rng = bte_crypto::os_rng();
        let ct = seal(&self.inner, payload, &mut rng)
            .map_err(|e| JsError::new(&format!("seal failed: {e}")))?;
        Ok(ct.to_bytes())
    }
}

/// Content address (hex sha256) of a sealed ciphertext's wire bytes.
#[wasm_bindgen]
pub fn ct_hash(sealed: &[u8]) -> Result<String, JsError> {
    let ct = SealedCiphertext::from_bytes(sealed)
        .map_err(|e| JsError::new(&format!("invalid sealed ciphertext: {e}")))?;
    Ok(hex::encode(ct.hash()))
}

#[cfg(feature = "verify")]
mod verify {
    use super::*;
    use bte_crypto::wire::header_from_bytes;
    use bte_crypto::{CtHeader, Share};

    /// Verify one operator's 48-byte share against a frozen batch.
    /// `headers` is the packed B*48-byte header blob from /v0/work or the
    /// explorer; `share_bytes` is the BTE_WIRE_V0 share.
    #[wasm_bindgen]
    pub fn verify_share(
        params: &Params,
        headers: &[u8],
        share_bytes: &[u8],
    ) -> Result<bool, JsError> {
        if headers.len() % 48 != 0 {
            return Err(JsError::new("headers must be a multiple of 48 bytes"));
        }
        let headers: Vec<CtHeader> = headers
            .chunks(48)
            .map(header_from_bytes)
            .collect::<Result<_, _>>()
            .map_err(|e| JsError::new(&format!("bad header: {e}")))?;
        let share =
            Share::from_bytes(share_bytes).map_err(|e| JsError::new(&format!("bad share: {e}")))?;
        Ok(bte_crypto::verify_share(&params.inner, &headers, &share))
    }
}
