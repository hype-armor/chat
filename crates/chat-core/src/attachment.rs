//! Attachment encryption (ADR-0024): a random key per file, the STREAM
//! construction over AES-256-GCM in 64 KiB chunks, so files are sealed and
//! opened piece by piece without holding them in memory.
//!
//! The plaintext is padded with zeros to a Padmé bucket (at most 12% larger)
//! so the server learns only an approximate size. The SHA-256 of the
//! ciphertext travels in the message with the key: it pins the exact blob,
//! which AES-GCM alone does not (it is not key-committing).

use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::stream::{DecryptorBE32, EncryptorBE32},
};
use sha2::{Digest, Sha256};

use crate::{Error, Result};

/// Plaintext bytes per chunk.
pub const CHUNK: usize = 64 * 1024;
const TAG: usize = 16;
pub const KEY_LEN: usize = 32;
/// The key is used for one file only, so a fixed nonce prefix is safe.
const NONCE_PREFIX: [u8; 7] = [0; 7];

/// Padmé padding: keeps the top bits of the length, rounding the rest up.
pub fn padded_len(len: u64) -> u64 {
    if len < 2 {
        return len;
    }
    let e = 63 - u64::from(len.leading_zeros());
    let s = 64 - u64::from(e.leading_zeros());
    let mask = (1u64 << (e - s)) - 1;
    (len + mask) & !mask
}

/// The ciphertext size for a file of `len` bytes.
pub fn sealed_len(len: u64) -> u64 {
    let padded = padded_len(len);
    padded + padded.div_ceil(CHUNK as u64).max(1) * TAG as u64
}

fn cipher(key: &[u8]) -> Result<Aes256Gcm> {
    Aes256Gcm::new_from_slice(key).map_err(|_| Error::Malformed("attachment key"))
}

fn sealing_failed<E>(_: E) -> Error {
    Error::Malformed("attachment encryption")
}

fn opening_failed<E>(_: E) -> Error {
    Error::Malformed("attachment does not decrypt")
}

/// What `Sealer::finish` returns.
pub struct Sealed {
    /// The last ciphertext bytes.
    pub tail: Vec<u8>,
    /// Plaintext size, without padding.
    pub size: u64,
    /// SHA-256 of the whole ciphertext.
    pub digest: Vec<u8>,
}

/// Encrypts a file fed in pieces of any size.
pub struct Sealer {
    enc: Option<EncryptorBE32<Aes256Gcm>>,
    buf: Vec<u8>,
    len: u64,
    hash: Sha256,
}

impl Sealer {
    pub fn new(key: &[u8]) -> Result<Self> {
        Ok(Self {
            enc: Some(EncryptorBE32::from_aead(cipher(key)?, &NONCE_PREFIX.into())),
            buf: Vec::new(),
            len: 0,
            hash: Sha256::new(),
        })
    }

    /// Returns ciphertext for the complete chunks so far.
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<u8>> {
        self.len += data.len() as u64;
        self.buf.extend_from_slice(data);
        self.drain()
    }

    pub fn finish(mut self) -> Result<Sealed> {
        let mut out = Vec::new();
        let mut zeros = padded_len(self.len) - self.len;
        while zeros > 0 {
            let n = zeros.min(CHUNK as u64);
            self.buf.resize(self.buf.len() + n as usize, 0);
            zeros -= n;
            out.extend(self.drain()?);
        }
        let enc = self.enc.take().ok_or(Error::Malformed("sealer finished"))?;
        out.extend(
            enc.encrypt_last(self.buf.as_slice())
                .map_err(sealing_failed)?,
        );
        self.hash.update(&out[out.len() - (self.buf.len() + TAG)..]);
        Ok(Sealed {
            tail: out,
            size: self.len,
            digest: self.hash.finalize().to_vec(),
        })
    }

    /// Encrypts all but the last chunk (which `finish` seals as the last).
    fn drain(&mut self) -> Result<Vec<u8>> {
        let enc = self
            .enc
            .as_mut()
            .ok_or(Error::Malformed("sealer finished"))?;
        let mut out = Vec::new();
        let mut at = 0;
        while self.buf.len() - at > CHUNK {
            let ct = enc
                .encrypt_next(&self.buf[at..at + CHUNK])
                .map_err(sealing_failed)?;
            self.hash.update(&ct);
            out.extend(ct);
            at += CHUNK;
        }
        self.buf.drain(..at);
        Ok(out)
    }
}

/// Decrypts and checks a file fed in pieces of any size.
pub struct Opener {
    dec: Option<DecryptorBE32<Aes256Gcm>>,
    buf: Vec<u8>,
    size: u64,
    /// Plaintext bytes so far, padding included.
    opened: u64,
    hash: Sha256,
    digest: Vec<u8>,
}

impl Opener {
    /// `size` and `digest` come from the attachment's message.
    pub fn new(key: &[u8], size: u64, digest: &[u8]) -> Result<Self> {
        Ok(Self {
            dec: Some(DecryptorBE32::from_aead(cipher(key)?, &NONCE_PREFIX.into())),
            buf: Vec::new(),
            size,
            opened: 0,
            hash: Sha256::new(),
            digest: digest.to_vec(),
        })
    }

    /// Returns plaintext for the complete chunks so far.
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<u8>> {
        self.hash.update(data);
        self.buf.extend_from_slice(data);
        let dec = self
            .dec
            .as_mut()
            .ok_or(Error::Malformed("opener finished"))?;
        let mut out = Vec::new();
        let mut at = 0;
        while self.buf.len() - at > CHUNK + TAG {
            let pt = dec
                .decrypt_next(&self.buf[at..at + CHUNK + TAG])
                .map_err(opening_failed)?;
            emit(self.size, &mut self.opened, &pt, &mut out);
            at += CHUNK + TAG;
        }
        self.buf.drain(..at);
        if self.opened > padded_len(self.size) {
            return Err(Error::Malformed("attachment longer than its size"));
        }
        Ok(out)
    }

    /// Returns the last plaintext bytes once the whole file checks out.
    pub fn finish(mut self) -> Result<Vec<u8>> {
        if self.hash.finalize_reset().as_slice() != self.digest.as_slice() {
            return Err(Error::Malformed("attachment does not match its digest"));
        }
        let dec = self.dec.take().ok_or(Error::Malformed("opener finished"))?;
        let pt = dec
            .decrypt_last(self.buf.as_slice())
            .map_err(opening_failed)?;
        let mut out = Vec::new();
        emit(self.size, &mut self.opened, &pt, &mut out);
        if self.opened != padded_len(self.size) {
            return Err(Error::Malformed("attachment size mismatch"));
        }
        Ok(out)
    }
}

/// Appends plaintext, dropping the padding past `size`.
fn emit(size: u64, opened: &mut u64, pt: &[u8], out: &mut Vec<u8>) {
    let keep = size.saturating_sub(*opened).min(pt.len() as u64) as usize;
    out.extend_from_slice(&pt[..keep]);
    *opened += pt.len() as u64;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seal(key: &[u8], data: &[u8], piece: usize) -> (Vec<u8>, Sealed) {
        let mut sealer = Sealer::new(key).unwrap();
        let mut ct = Vec::new();
        for p in data.chunks(piece.max(1)) {
            ct.extend(sealer.push(p).unwrap());
        }
        let sealed = sealer.finish().unwrap();
        ct.extend(&sealed.tail);
        (ct, sealed)
    }

    fn open(key: &[u8], ct: &[u8], size: u64, digest: &[u8], piece: usize) -> Result<Vec<u8>> {
        let mut opener = Opener::new(key, size, digest)?;
        let mut pt = Vec::new();
        for p in ct.chunks(piece.max(1)) {
            pt.extend(opener.push(p)?);
        }
        pt.extend(opener.finish()?);
        Ok(pt)
    }

    #[test]
    fn padme_bounds_overhead() {
        assert_eq!(padded_len(0), 0);
        assert_eq!(padded_len(1), 1);
        assert_eq!(padded_len(1000), 1024);
        for len in [3u64, 100, 65_537, 1_000_000, 104_857_600] {
            let p = padded_len(len);
            assert!(p >= len && p - len <= len / 8 + 1, "{len} -> {p}");
        }
    }

    #[test]
    fn round_trips_any_piece_sizes() {
        let key = [7u8; KEY_LEN];
        for len in [
            0usize,
            1,
            100,
            CHUNK - 1,
            CHUNK,
            CHUNK + 1,
            3 * CHUNK + 5000,
        ] {
            let data: Vec<u8> = (0..len).map(|i| (i * 31) as u8).collect();
            for (seal_piece, open_piece) in [(1000, 70_000), (CHUNK, 1), (len, len)] {
                if len > 100_000 && (seal_piece < 100 || open_piece < 100) {
                    continue;
                }
                let (ct, sealed) = seal(&key, &data, seal_piece);
                assert_eq!(ct.len() as u64, sealed_len(len as u64));
                assert_eq!(sealed.size, len as u64);
                assert_eq!(Sha256::digest(&ct).to_vec(), sealed.digest);
                let pt = open(&key, &ct, sealed.size, &sealed.digest, open_piece).unwrap();
                assert_eq!(pt, data);
            }
        }
    }

    #[test]
    fn rejects_tampering_truncation_and_wrong_keys() {
        let key = [1u8; KEY_LEN];
        let data = vec![9u8; 2 * CHUNK + 10];
        let (ct, s) = seal(&key, &data, 4096);
        // Wrong key.
        assert!(open(&[2u8; KEY_LEN], &ct, s.size, &s.digest, 4096).is_err());
        // A flipped bit, with and without a matching digest.
        let mut bad = ct.clone();
        bad[10] ^= 1;
        assert!(open(&key, &bad, s.size, &s.digest, 4096).is_err());
        assert!(open(&key, &bad, s.size, &Sha256::digest(&bad), 4096).is_err());
        // Dropping the last chunk: the new last chunk was not sealed as last.
        let cut = &ct[..2 * (CHUNK + TAG)];
        assert!(open(&key, cut, s.size, &Sha256::digest(cut), 4096).is_err());
        // A size that disagrees with the padding.
        assert!(open(&key, &ct, s.size + 5000, &s.digest, 4096).is_err());
        assert!(Sealer::new(&[0u8; 5]).is_err());
    }
}
