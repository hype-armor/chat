//! Length-hiding padding applied to plaintext before MLS encryption
//! (docs/04-security-and-cryptography.md §4).
//!
//! Layout: `[u32 big-endian length][payload][zero bytes]`, padded up to the
//! next power of two, with a 256-byte minimum.

use crate::{Error, Result};

const MIN_BUCKET: usize = 256;
const LEN_PREFIX: usize = 4;

pub fn pad(payload: &[u8]) -> Vec<u8> {
    let needed = LEN_PREFIX + payload.len();
    let bucket = needed.next_power_of_two().max(MIN_BUCKET);
    let mut out = Vec::with_capacity(bucket);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out.resize(bucket, 0);
    out
}

pub fn unpad(padded: &[u8]) -> Result<&[u8]> {
    let prefix: [u8; LEN_PREFIX] = padded
        .get(..LEN_PREFIX)
        .and_then(|p| p.try_into().ok())
        .ok_or(Error::Malformed("padding prefix"))?;
    let len = u32::from_be_bytes(prefix) as usize;
    padded
        .get(LEN_PREFIX..LEN_PREFIX + len)
        .ok_or(Error::Malformed("padding length"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_hides_length() {
        for len in [0, 1, 100, 252, 253, 5000] {
            let payload = vec![7u8; len];
            let padded = pad(&payload);
            assert!(padded.len().is_power_of_two());
            assert!(padded.len() >= MIN_BUCKET);
            assert_eq!(unpad(&padded).unwrap(), payload.as_slice());
        }
        assert_eq!(pad(b"a").len(), pad(b"abc").len());
    }

    #[test]
    fn rejects_truncated_input() {
        assert!(unpad(&[0, 0]).is_err());
        assert!(unpad(&[0, 0, 0, 9, 1]).is_err());
    }
}
