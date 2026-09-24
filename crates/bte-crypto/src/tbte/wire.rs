//! BTE_WIRE_V1 serialization. Every wire type: magic `BTE1`, one type byte,
//! then a fixed layout. Group elements are arkworks canonical compressed
//! (G1 48 B, G2 96 B, scalar 32 B). Integers little-endian. Deserialization
//! is strict: points are curve- and subgroup-checked, trailing bytes
//! rejected, scalars must be canonical.

use super::{Ciphertext, CtHeader, OperatorSecret, Proof, PublicParams, Share, BTE_WIRE_V1};
use crate::BteError;
use ark_bls12_381::{Fr, G1Affine, G2Affine};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};

pub const TYPE_CIPHERTEXT: u8 = 0x01;
pub const TYPE_SHARE: u8 = 0x02;
pub const TYPE_PUBLIC_PARAMS: u8 = 0x03;
pub const TYPE_OPERATOR_SECRET: u8 = 0x04;
pub const TYPE_HEADER: u8 = 0x05;

pub const G1_BYTES: usize = 48;
pub const G2_BYTES: usize = 96;
pub const SCALAR_BYTES: usize = 32;
const TAG_BYTES: usize = 5;

/// A framed header is always exactly this long, so batches pack headers
/// back to back and split by this constant.
pub const HEADER_BYTES: usize = TAG_BYTES + G1_BYTES + G2_BYTES + G1_BYTES + 32 + 2 * SCALAR_BYTES;
/// A framed share: tag, party index, one G1 point.
pub const SHARE_BYTES: usize = TAG_BYTES + 2 + G1_BYTES;
/// Fixed ciphertext overhead beyond the payload: framing, three points, the
/// proof, the body length, and the AEAD tag.
pub const CIPHERTEXT_OVERHEAD_BYTES: usize =
    TAG_BYTES + G1_BYTES + G2_BYTES + G1_BYTES + 2 * SCALAR_BYTES + 4 + super::DEM_TAG_BYTES;

fn wire_err(what: &str) -> BteError {
    BteError::Wire(what.to_string())
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8], expected_type: u8) -> Result<Self, BteError> {
        let mut r = Reader { buf, pos: 0 };
        let magic = r.take(4)?;
        if magic != BTE_WIRE_V1 {
            return Err(wire_err("bad magic, expected BTE1"));
        }
        let ty = r.u8()?;
        if ty != expected_type {
            return Err(wire_err("unexpected wire type byte"));
        }
        Ok(r)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], BteError> {
        if self.buf.len() - self.pos < n {
            return Err(wire_err("truncated"));
        }
        let out = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, BteError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, BteError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, BteError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn bytes32(&mut self) -> Result<[u8; 32], BteError> {
        Ok(self.take(32)?.try_into().unwrap())
    }

    fn g1(&mut self) -> Result<G1Affine, BteError> {
        G1Affine::deserialize_compressed(self.take(G1_BYTES)?)
            .map_err(|_| wire_err("invalid G1 point"))
    }

    fn g2(&mut self) -> Result<G2Affine, BteError> {
        G2Affine::deserialize_compressed(self.take(G2_BYTES)?)
            .map_err(|_| wire_err("invalid G2 point"))
    }

    fn scalar(&mut self) -> Result<Fr, BteError> {
        Fr::deserialize_compressed(self.take(SCALAR_BYTES)?).map_err(|_| wire_err("invalid scalar"))
    }

    fn proof(&mut self) -> Result<Proof, BteError> {
        Ok(Proof {
            c: self.scalar()?,
            z: self.scalar()?,
        })
    }

    fn finish(self) -> Result<(), BteError> {
        if self.pos != self.buf.len() {
            return Err(wire_err("trailing bytes"));
        }
        Ok(())
    }
}

fn header(out: &mut Vec<u8>, ty: u8) {
    out.extend_from_slice(BTE_WIRE_V1);
    out.push(ty);
}

fn put<T: CanonicalSerialize>(out: &mut Vec<u8>, p: &T, expect: usize) {
    let start = out.len();
    p.serialize_compressed(&mut *out)
        .expect("canonical serialization cannot fail on a Vec");
    debug_assert_eq!(out.len() - start, expect, "unexpected compressed size");
}

fn put_proof(out: &mut Vec<u8>, proof: &Proof) {
    put(out, &proof.c, SCALAR_BYTES);
    put(out, &proof.z, SCALAR_BYTES);
}

impl Ciphertext {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(CIPHERTEXT_OVERHEAD_BYTES + self.body.len());
        header(&mut out, TYPE_CIPHERTEXT);
        put(&mut out, &self.ct1, G1_BYTES);
        put(&mut out, &self.ct2, G2_BYTES);
        put(&mut out, &self.ct3, G1_BYTES);
        put_proof(&mut out, &self.proof);
        out.extend_from_slice(&(self.body.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.body);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, BteError> {
        let mut r = Reader::new(bytes, TYPE_CIPHERTEXT)?;
        let ct1 = r.g1()?;
        let ct2 = r.g2()?;
        let ct3 = r.g1()?;
        let proof = r.proof()?;
        let len = r.u32()? as usize;
        if len < super::DEM_TAG_BYTES {
            return Err(wire_err("body shorter than the AEAD tag"));
        }
        if len - super::DEM_TAG_BYTES > crate::MAX_PAYLOAD_BYTES {
            return Err(BteError::PayloadTooLarge);
        }
        let body = r.take(len)?.to_vec();
        r.finish()?;
        Ok(Ciphertext {
            ct1,
            ct2,
            ct3,
            proof,
            body,
        })
    }
}

impl CtHeader {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER_BYTES);
        header(&mut out, TYPE_HEADER);
        put(&mut out, &self.ct1, G1_BYTES);
        put(&mut out, &self.ct2, G2_BYTES);
        put(&mut out, &self.ct3, G1_BYTES);
        out.extend_from_slice(&self.body_hash);
        put_proof(&mut out, &self.proof);
        debug_assert_eq!(out.len(), HEADER_BYTES);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, BteError> {
        let mut r = Reader::new(bytes, TYPE_HEADER)?;
        let ct1 = r.g1()?;
        let ct2 = r.g2()?;
        let ct3 = r.g1()?;
        let body_hash = r.bytes32()?;
        let proof = r.proof()?;
        r.finish()?;
        Ok(CtHeader {
            ct1,
            ct2,
            ct3,
            body_hash,
            proof,
        })
    }
}

/// Pack headers back to back (each framed, `HEADER_BYTES` long).
pub fn pack_headers(headers: &[CtHeader]) -> Vec<u8> {
    let mut out = Vec::with_capacity(headers.len() * HEADER_BYTES);
    for h in headers {
        out.extend_from_slice(&h.to_bytes());
    }
    out
}

/// Split a packed header blob. Rejects a length that is not a multiple of
/// `HEADER_BYTES` and any header that does not parse.
pub fn unpack_headers(bytes: &[u8]) -> Result<Vec<CtHeader>, BteError> {
    if !bytes.len().is_multiple_of(HEADER_BYTES) {
        return Err(wire_err(
            "packed headers must be a multiple of HEADER_BYTES",
        ));
    }
    bytes
        .chunks(HEADER_BYTES)
        .map(CtHeader::from_bytes)
        .collect()
}

impl Share {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(SHARE_BYTES);
        header(&mut out, TYPE_SHARE);
        out.extend_from_slice(&self.party_index.to_le_bytes());
        put(&mut out, &self.value, G1_BYTES);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, BteError> {
        let mut r = Reader::new(bytes, TYPE_SHARE)?;
        let party_index = r.u16()?;
        if party_index == 0 {
            return Err(wire_err("party index is 1-based"));
        }
        let value = r.g1()?;
        r.finish()?;
        Ok(Share { party_index, value })
    }
}

impl PublicParams {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out =
            Vec::with_capacity(TAG_BYTES + 4 + 32 + G1_BYTES * (1 + self.operator_keys.len()));
        header(&mut out, TYPE_PUBLIC_PARAMS);
        out.extend_from_slice(&self.n.to_le_bytes());
        out.extend_from_slice(&self.t.to_le_bytes());
        out.extend_from_slice(&self.setup_digest);
        put(&mut out, &self.pk, G1_BYTES);
        for key in &self.operator_keys {
            put(&mut out, key, G1_BYTES);
        }
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, BteError> {
        let mut r = Reader::new(bytes, TYPE_PUBLIC_PARAMS)?;
        let n = r.u16()?;
        let t = r.u16()?;
        if n == 0 || t == 0 || t > n {
            return Err(wire_err("invalid committee parameters"));
        }
        let setup_digest = r.bytes32()?;
        let pk = r.g1()?;
        let mut operator_keys = Vec::with_capacity(n as usize);
        for _ in 0..n {
            operator_keys.push(r.g1()?);
        }
        r.finish()?;
        PublicParams::assemble(n, t, pk, operator_keys, setup_digest)
    }
}

impl OperatorSecret {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(TAG_BYTES + 2 + SCALAR_BYTES);
        header(&mut out, TYPE_OPERATOR_SECRET);
        out.extend_from_slice(&self.party_index.to_le_bytes());
        put(&mut out, &self.share, SCALAR_BYTES);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, BteError> {
        let mut r = Reader::new(bytes, TYPE_OPERATOR_SECRET)?;
        let party_index = r.u16()?;
        if party_index == 0 {
            return Err(wire_err("party index is 1-based"));
        }
        let share = r.scalar()?;
        r.finish()?;
        Ok(OperatorSecret { party_index, share })
    }
}

/// True if a blob carries the v1 magic (used to dispatch between schemes).
pub fn is_v1(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..4] == BTE_WIRE_V1
}
