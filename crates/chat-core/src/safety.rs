//! Safety numbers (FR-ID-5, ADR-0020): 60 digits two people compare, out of
//! band, to check that the server gave each of them the other's real
//! device keys. Same construction as Signal's numeric fingerprints, with
//! an account's sorted device signature keys in place of one identity key.

use sha2::{Digest, Sha512};

const VERSION: [u8; 2] = [0, 0];
const ITERATIONS: usize = 5200;

/// 30 digits identifying one account's set of device keys.
fn fingerprint(account: &[u8], keys: &[Vec<u8>]) -> String {
    let mut sorted: Vec<&[u8]> = keys.iter().map(Vec::as_slice).collect();
    sorted.sort_unstable();
    sorted.dedup();
    let key_material: Vec<u8> = sorted.concat();
    let mut hash = Sha512::new()
        .chain_update(VERSION)
        .chain_update(&key_material)
        .chain_update(account)
        .finalize();
    for _ in 0..ITERATIONS {
        hash = Sha512::new()
            .chain_update(hash)
            .chain_update(&key_material)
            .finalize();
    }
    hash[..30]
        .chunks(5)
        .map(|chunk| {
            let n = chunk.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b));
            format!("{:05}", n % 100_000)
        })
        .collect()
}

/// The same 60 digits on both sides: the two fingerprints in sorted order.
pub fn safety_number(
    my_account: &[u8],
    my_keys: &[Vec<u8>],
    their_account: &[u8],
    their_keys: &[Vec<u8>],
) -> String {
    let mut parts = [
        fingerprint(my_account, my_keys),
        fingerprint(their_account, their_keys),
    ];
    parts.sort_unstable();
    parts.concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(seeds: &[u8]) -> Vec<Vec<u8>> {
        seeds.iter().map(|s| vec![*s; 32]).collect()
    }

    #[test]
    fn both_sides_compute_the_same_number() {
        let (alice, bob) = (b"alice-account-id", b"bob-account-id--");
        let n = safety_number(alice, &keys(&[1, 2]), bob, &keys(&[3]));
        assert_eq!(n.len(), 60);
        assert!(n.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(n, safety_number(bob, &keys(&[3]), alice, &keys(&[1, 2])));
        // Device order doesn't matter.
        assert_eq!(n, safety_number(alice, &keys(&[2, 1]), bob, &keys(&[3])));
    }

    #[test]
    fn any_key_change_changes_the_number() {
        let (alice, bob) = (b"alice-account-id", b"bob-account-id--");
        let n = safety_number(alice, &keys(&[1]), bob, &keys(&[3]));
        assert_ne!(n, safety_number(alice, &keys(&[1]), bob, &keys(&[4])));
        assert_ne!(n, safety_number(alice, &keys(&[1]), bob, &keys(&[3, 4])));
        assert_ne!(n, safety_number(alice, &keys(&[1, 2]), bob, &keys(&[3])));
    }
}
