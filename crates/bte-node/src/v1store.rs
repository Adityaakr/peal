//! Encrypted store for an operator's BTE v1 share, one file per committee,
//! beside the committee's public parameters so the node can serve work for
//! it after a restart without asking anyone.

use crate::keystore::{open_bytes, seal_bytes, Encrypted};
use anyhow::{bail, Context, Result};
use base64::Engine;
use bte_crypto::tbte::{OperatorSecret, PublicParams};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
pub const KIND: &str = "bte-v1-operator-share";

#[derive(Serialize, Deserialize)]
pub struct ShareFile {
    pub version: u32,
    pub kind: String,
    pub committee_id: String,
    pub party_index: u16,
    pub params_b64: String,
    #[serde(flatten)]
    pub encrypted: Encrypted,
}

/// A committee this operator holds a share of.
pub struct HeldCommittee {
    pub committee_id: String,
    pub party_index: u16,
    pub params: PublicParams,
    pub secret: OperatorSecret,
}

pub fn seal_share(
    committee_id: &str,
    params: &PublicParams,
    secret: &OperatorSecret,
    passphrase: &str,
) -> Result<ShareFile> {
    Ok(ShareFile {
        version: 2,
        kind: KIND.into(),
        committee_id: committee_id.to_string(),
        party_index: secret.party_index,
        params_b64: B64.encode(params.to_bytes()),
        encrypted: seal_bytes(&secret.to_bytes(), passphrase)?,
    })
}

pub fn open_share(file: &ShareFile, passphrase: &str) -> Result<HeldCommittee> {
    if file.version != 2 || file.kind != KIND {
        bail!("not a v1 operator share file");
    }
    let params_bytes = B64.decode(&file.params_b64).context("params encoding")?;
    let params = PublicParams::from_bytes(&params_bytes)
        .map_err(|e| anyhow::anyhow!("share file params invalid: {e}"))?;
    if hex::encode(params.digest()) != file.committee_id {
        bail!("share file committee id does not match its params");
    }
    let secret = OperatorSecret::from_bytes(&open_bytes(&file.encrypted, passphrase)?)
        .map_err(|e| anyhow::anyhow!("share payload invalid: {e}"))?;
    if secret.party_index != file.party_index {
        bail!("share file party index does not match the sealed share");
    }
    let expected = params
        .operator_keys()
        .get(secret.party_index as usize - 1)
        .copied()
        .context("party index outside the committee")?;
    if secret.public_key() != expected {
        bail!("sealed share does not match the committee's operator key");
    }
    Ok(HeldCommittee {
        committee_id: file.committee_id.clone(),
        party_index: file.party_index,
        params,
        secret,
    })
}

pub fn share_path(state_dir: &Path, committee_id: &str) -> PathBuf {
    state_dir.join(format!("committee-{committee_id}.share"))
}

pub fn write_share(path: &Path, file: &ShareFile) -> Result<()> {
    write_private(path, &serde_json::to_vec_pretty(file)?)
}

/// Write a file only its owner can read (0600), atomically: a temp file
/// beside it, fsync, rename. Nothing half-written is ever loaded.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(&tmp)
        .with_context(|| format!("creating {}", tmp.display()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
    Ok(())
}

/// Every share file in the state directory that opens with this passphrase.
pub fn load_all(state_dir: &Path, passphrase: &str) -> Result<Vec<HeldCommittee>> {
    let mut held = Vec::new();
    let Ok(entries) = std::fs::read_dir(state_dir) else {
        return Ok(held);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !(name.starts_with("committee-") && name.ends_with(".share")) {
            continue;
        }
        // One unreadable file must not keep the node from serving the others.
        let parsed = std::fs::read(&path)
            .map_err(|e| anyhow::anyhow!("{e}"))
            .and_then(|bytes| {
                serde_json::from_slice::<ShareFile>(&bytes).map_err(|e| anyhow::anyhow!("{e}"))
            })
            .and_then(|file| open_share(&file, passphrase));
        match parsed {
            Ok(share) => held.push(share),
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "skipping a share file that does not open")
            }
        }
    }
    Ok(held)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bte_crypto::rand::SeedableRng;

    #[test]
    fn roundtrip_checks_index_and_key() {
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(3);
        let (params, secrets) = bte_crypto::tbte::dev::deal(3, 2, &mut rng).unwrap();
        let id = hex::encode(params.digest());
        let file = seal_share(&id, &params, &secrets[1], "pw").unwrap();
        let held = open_share(&file, "pw").unwrap();
        assert_eq!(held.party_index, 2);
        assert_eq!(held.secret.public_key(), params.operator_keys()[1]);
        assert!(open_share(&file, "wrong").is_err());
        let mut wrong_index = seal_share(&id, &params, &secrets[1], "pw").unwrap();
        wrong_index.party_index = 1;
        assert!(open_share(&wrong_index, "pw").is_err());
    }
}
