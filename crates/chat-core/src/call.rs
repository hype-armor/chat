//! SFrame for call media (RFC 9605, ADR-0030), on top of the `sframe` crate.
//!
//! Keys come from the conversation's MLS group: the exporter gives a base
//! key per call and epoch (label "chat call sframe", context the call id),
//! and each sender's key ID follows RFC 9605 §5.2 (the sender's leaf index
//! and the epoch's low bits), so every device encrypts under its own key.
//! The page never sees these keys: frames are encrypted here, in the core
//! worker.

use std::collections::{HashMap, VecDeque};

use sframe::{
    CipherSuite,
    frame::{EncryptedFrameView, MediaFrameView, MonotonicCounter},
    key::{DecryptionKey, EncryptionKey},
    mls::{MlsKeyId, MlsKeyIdBitRange},
};

use crate::{Error, Result};

const SUITE: CipherSuite = CipherSuite::AesGcm128Sha256;
/// Length of the exported base key (HKDF input).
pub const BASE_KEY_LEN: usize = 32;
/// 8 bits of epoch and 8 of leaf index (groups of 50 people with a few
/// devices each fit); the context ID stays 0.
fn bit_range() -> MlsKeyIdBitRange {
    MlsKeyIdBitRange::new(8, 8)
}
/// Epochs whose receive keys are kept for frames still in flight.
const KEPT_EPOCHS: usize = 2;
/// The largest frame accepted (a 4K key frame fits).
const MAX_FRAME: usize = 4 * 1024 * 1024;

fn key_id(epoch: u64, leaf: u32) -> Result<u64> {
    MlsKeyId::try_new(0u64, epoch, leaf, bit_range())
        .map(Into::into)
        .map_err(|_| Error::Malformed("leaf index out of range"))
}

/// One epoch that was installed here: the base key it came from and the
/// receive key IDs it added.
struct Installed {
    epoch: u64,
    base: Vec<u8>,
    ids: Vec<u64>,
}

/// One call's SFrame keys on one device.
pub struct CallKeys {
    counter: MonotonicCounter,
    send: Option<EncryptionKey>,
    receive: HashMap<u64, DecryptionKey>,
    /// Epochs installed here, oldest first.
    epochs: VecDeque<Installed>,
}

impl Default for CallKeys {
    fn default() -> Self {
        Self::new()
    }
}

impl CallKeys {
    pub fn new() -> Self {
        Self {
            counter: MonotonicCounter::default(),
            send: None,
            receive: HashMap::new(),
            epochs: VecDeque::new(),
        }
    }

    /// Installs an epoch's keys: `base_key` from the MLS exporter, this
    /// device's leaf and the other members' leaves. Sending moves to the new
    /// epoch at once; receive keys of the previous epoch stay for a while.
    ///
    /// An epoch installs once, and a base key is used for one epoch only.
    /// Installing what is already installed is a no-op: the key state and the
    /// frame counter stay as they are, so no AES-GCM nonce repeats (audit
    /// M10). A device that rejoins a call keeps the keys it has.
    pub fn install(&mut self, base_key: &[u8], epoch: u64, own: u32, others: &[u32]) -> Result<()> {
        if let Some(existing) = self.epochs.iter().find(|e| e.epoch == epoch) {
            return if existing.base == base_key {
                Ok(())
            } else {
                Err(Error::Malformed("this epoch already has other keys"))
            };
        }
        if self.epochs.iter().any(|e| e.base == base_key) {
            return Err(Error::Malformed(
                "call base key already used for another epoch",
            ));
        }
        let crypto = |_| Error::Malformed("call key derivation failed");
        self.send =
            Some(EncryptionKey::derive_from(SUITE, key_id(epoch, own)?, base_key).map_err(crypto)?);
        let mut ids = Vec::new();
        for &leaf in others {
            let id = key_id(epoch, leaf)?;
            self.receive.insert(
                id,
                DecryptionKey::derive_from(SUITE, id, base_key).map_err(crypto)?,
            );
            ids.push(id);
        }
        self.epochs.push_back(Installed {
            epoch,
            base: base_key.to_vec(),
            ids,
        });
        while self.epochs.len() > KEPT_EPOCHS {
            if let Some(old) = self.epochs.pop_front() {
                for id in old.ids {
                    self.receive.remove(&id);
                }
            }
        }
        Ok(())
    }

    /// Encrypts a frame. The first `clear` bytes (codec headers the
    /// packetizer needs) stay readable but are authenticated; the result
    /// is those bytes followed by the SFrame header and ciphertext.
    pub fn encrypt(&mut self, frame: &[u8], clear: usize) -> Result<Vec<u8>> {
        let key = self
            .send
            .as_ref()
            .ok_or(Error::Malformed("no call key yet"))?;
        if frame.len() > MAX_FRAME || clear > frame.len() {
            return Err(Error::Malformed("frame"));
        }
        let (meta, payload) = frame.split_at(clear);
        let media = MediaFrameView::try_with_meta_data(&mut self.counter, payload, meta)
            .map_err(|_| Error::Malformed("frame counter exhausted"))?;
        let mut out = Vec::new();
        media
            .encrypt_into(key, &mut out)
            .map_err(|_| Error::Malformed("frame encryption failed"))?;
        Ok(out)
    }

    /// Decrypts a frame from [`Self::encrypt`] with the same `clear` length.
    pub fn decrypt(&self, frame: &[u8], clear: usize) -> Result<Vec<u8>> {
        if frame.len() > MAX_FRAME + 64 || clear > frame.len() {
            return Err(Error::Malformed("frame"));
        }
        let (meta, data) = frame.split_at(clear);
        let encrypted = EncryptedFrameView::try_with_meta_data(&data, &meta)
            .map_err(|_| Error::Malformed("frame"))?;
        let mut out = Vec::new();
        encrypted
            .decrypt_into(&self.receive, &mut out)
            .map_err(|_| Error::Malformed("frame did not decrypt"))?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(base: &[u8], epoch: u64) -> (CallKeys, CallKeys) {
        let mut a = CallKeys::new();
        let mut b = CallKeys::new();
        a.install(base, epoch, 0, &[1]).unwrap();
        b.install(base, epoch, 1, &[0]).unwrap();
        (a, b)
    }

    #[test]
    fn frames_round_trip_with_a_clear_header() {
        let (mut a, b) = pair(&[7; BASE_KEY_LEN], 3);
        let frame = b"0123456789 video payload".to_vec();
        let sealed = a.encrypt(&frame, 10).unwrap();
        // The codec header stays readable; the rest doesn't.
        assert_eq!(&sealed[..10], &frame[..10]);
        assert!(!sealed.windows(7).any(|w| w == b"payload"));
        assert_eq!(b.decrypt(&sealed, 10).unwrap(), frame);
        // The header is authenticated.
        let mut forged = sealed.clone();
        forged[0] ^= 1;
        assert!(b.decrypt(&forged, 10).is_err());
    }

    #[test]
    fn each_sender_has_its_own_key() {
        let (mut a, mut b) = pair(&[7; BASE_KEY_LEN], 3);
        let from_a = a.encrypt(b"audio", 0).unwrap();
        let from_b = b.encrypt(b"audio", 0).unwrap();
        assert_ne!(from_a, from_b);
        // Nobody accepts their own key ID back (no reflection).
        assert!(a.decrypt(&from_a, 0).is_err());
        assert_eq!(a.decrypt(&from_b, 0).unwrap(), b"audio");
    }

    #[test]
    fn other_calls_and_epochs_do_not_decrypt() {
        let (mut a, _) = pair(&[7; BASE_KEY_LEN], 3);
        let (_, other) = pair(&[8; BASE_KEY_LEN], 3);
        assert!(other.decrypt(&a.encrypt(b"x", 0).unwrap(), 0).is_err());
    }

    #[test]
    fn a_rejoin_does_not_restart_the_frame_counter() {
        let (mut a, b) = pair(&[7; BASE_KEY_LEN], 3);
        let first = a.encrypt(b"frame", 0).unwrap();
        assert_eq!(b.decrypt(&first, 0).unwrap(), b"frame");
        for _ in 0..2 {
            let sealed = a.encrypt(b"frame", 0).unwrap();
            assert_eq!(b.decrypt(&sealed, 0).unwrap(), b"frame");
        }
        assert_eq!(a.counter.current(), 3);
        // A device that rejoins the same call and installs the same epoch
        // again keeps its key state: nothing restarts at counter 0.
        a.install(&[7; BASE_KEY_LEN], 3, 0, &[1]).unwrap();
        assert_eq!(a.counter.current(), 3);
        // The counter goes on, so the next frame repeats no nonce of frame 0.
        let again = a.encrypt(b"frame", 0).unwrap();
        assert_ne!(again, first);
        assert_eq!(a.counter.current(), 4);
        assert_eq!(b.decrypt(&again, 0).unwrap(), b"frame");
    }

    #[test]
    fn another_base_key_cannot_replace_a_live_epoch() {
        let (mut a, b) = pair(&[7; BASE_KEY_LEN], 3);
        assert!(a.install(&[8; BASE_KEY_LEN], 3, 0, &[1]).is_err());
        // The keys of epoch 3 still work.
        let sealed = a.encrypt(b"still epoch 3", 0).unwrap();
        assert_eq!(b.decrypt(&sealed, 0).unwrap(), b"still epoch 3");
    }

    #[test]
    fn a_different_base_key_installs_fine() {
        let (mut a, mut b) = pair(&[7; BASE_KEY_LEN], 3);
        a.install(&[8; BASE_KEY_LEN], 4, 0, &[1]).unwrap();
        b.install(&[8; BASE_KEY_LEN], 4, 1, &[0]).unwrap();
        let sealed = a.encrypt(b"next epoch", 0).unwrap();
        assert_eq!(b.decrypt(&sealed, 0).unwrap(), b"next epoch");
        // The same base key for another epoch is a mistake, not a rekey.
        assert!(a.install(&[8; BASE_KEY_LEN], 5, 0, &[1]).is_err());
    }

    #[test]
    fn a_new_epoch_keeps_the_previous_one_for_frames_in_flight() {
        let (mut a, mut b) = pair(&[7; BASE_KEY_LEN], 3);
        let old = a.encrypt(b"old", 0).unwrap();
        a.install(&[9; BASE_KEY_LEN], 4, 0, &[1]).unwrap();
        b.install(&[9; BASE_KEY_LEN], 4, 1, &[0]).unwrap();
        let new = a.encrypt(b"new", 0).unwrap();
        assert_eq!(b.decrypt(&old, 0).unwrap(), b"old");
        assert_eq!(b.decrypt(&new, 0).unwrap(), b"new");
        b.install(&[1; BASE_KEY_LEN], 5, 1, &[0]).unwrap();
        b.install(&[2; BASE_KEY_LEN], 6, 1, &[0]).unwrap();
        assert!(b.decrypt(&old, 0).is_err());
    }
}
