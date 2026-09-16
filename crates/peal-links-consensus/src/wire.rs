//! Messages on the three application channels. Framing is one tag byte
//! followed by the payload; the consensus channels (votes, certificates,
//! backfill) are the engine's own and never appear here.

use crate::block::Id;

/// Channel numbers registered with the network. 0 to 2 belong to the
/// engine (votes, certificates, resolver).
pub const CH_VOTE: u64 = 0;
pub const CH_CERTIFICATE: u64 = 1;
pub const CH_RESOLVER: u64 = 2;
pub const CH_BLOCKS: u64 = 3;
pub const CH_TXS: u64 = 4;
pub const CH_APP: u64 = 5;

/// Block distribution: full block bytes, or a request for them by digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlockWire {
    Block(Vec<u8>),
    Request(Id),
}

impl BlockWire {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            BlockWire::Block(bytes) => {
                let mut v = Vec::with_capacity(1 + bytes.len());
                v.push(0);
                v.extend_from_slice(bytes);
                v
            }
            BlockWire::Request(id) => {
                let mut v = Vec::with_capacity(33);
                v.push(1);
                v.extend_from_slice(id);
                v
            }
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        match bytes.first() {
            Some(0) => Ok(BlockWire::Block(bytes[1..].to_vec())),
            Some(1) if bytes.len() == 33 => {
                let mut id = [0u8; 32];
                id.copy_from_slice(&bytes[1..]);
                Ok(BlockWire::Request(id))
            }
            _ => Err("malformed block message".into()),
        }
    }
}

/// Application request/response between validators (used for settlement
/// signatures). The body is opaque to the consensus crate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppWire {
    Request { id: u64, body: Vec<u8> },
    Response { id: u64, body: Vec<u8> },
}

impl AppWire {
    pub fn encode(&self) -> Vec<u8> {
        let (tag, id, body) = match self {
            AppWire::Request { id, body } => (0u8, *id, body),
            AppWire::Response { id, body } => (1u8, *id, body),
        };
        let mut v = Vec::with_capacity(9 + body.len());
        v.push(tag);
        v.extend_from_slice(&id.to_le_bytes());
        v.extend_from_slice(body);
        v
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 9 {
            return Err("malformed application message".into());
        }
        let mut id = [0u8; 8];
        id.copy_from_slice(&bytes[1..9]);
        let id = u64::from_le_bytes(id);
        let body = bytes[9..].to_vec();
        match bytes[0] {
            0 => Ok(AppWire::Request { id, body }),
            1 => Ok(AppWire::Response { id, body }),
            _ => Err("malformed application message".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        for m in [
            BlockWire::Block(vec![1, 2, 3]),
            BlockWire::Request([7u8; 32]),
        ] {
            assert_eq!(BlockWire::decode(&m.encode()).unwrap(), m);
        }
        for m in [
            AppWire::Request {
                id: 5,
                body: vec![9],
            },
            AppWire::Response {
                id: u64::MAX,
                body: vec![],
            },
        ] {
            assert_eq!(AppWire::decode(&m.encode()).unwrap(), m);
        }
        assert!(BlockWire::decode(&[1, 2]).is_err());
        assert!(AppWire::decode(&[0]).is_err());
    }
}
