//! Disabled prototype. No runtime acceptance path uses this module.
//!
//! Inputs are not proof. The caller must capture rosters from authenticated MLS
//! state after each successfully processed commit, and advisory admins from an
//! independently authenticated source. It must hold all relevant locks and
//! atomically persist MLS state, this history, acceptance and the rollback anchor.
//! The anchor must itself resist rollback; a digest stored beside the snapshot
//! does not do so. A missing anchor or history must never trigger reinitialization.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const VERSION: u8 = 1;
const MAX_EPOCHS: usize = 256;
const MAX_DEVICES: usize = 256;
const MAX_SNAPSHOT: usize = 128 * 1024;

#[derive(Clone, Serialize, Deserialize)]
struct Epoch {
    number: u64,
    devices: Vec<Vec<u8>>,
    admins: Vec<Vec<u8>>,
}

/// One independently associated parent, channel and direct conversation.
/// This is not an authentication boundary for caller-supplied inputs.
#[derive(Clone, Serialize, Deserialize)]
pub struct History {
    version: u8,
    parent: Vec<u8>,
    channel: Vec<u8>,
    direct: Vec<u8>,
    parents: Vec<Epoch>,
    directs: Vec<Epoch>,
    generation: u64,
}

fn valid_epoch(epoch: &Epoch, parent: bool) -> bool {
    let devices: BTreeSet<_> = epoch.devices.iter().collect();
    let admins: BTreeSet<_> = epoch.admins.iter().collect();
    !devices.is_empty()
        && devices.len() == epoch.devices.len()
        && devices.len() <= MAX_DEVICES
        && devices.iter().all(|d| d.len() == 32)
        && admins.len() == epoch.admins.len()
        && admins.len() <= MAX_DEVICES
        && admins
            .iter()
            .all(|a| a.len() == 16 && devices.iter().any(|d| d[..16] == a[..]))
        && if parent {
            !admins.is_empty()
        } else {
            admins.is_empty()
        }
}

fn valid_sequence(epochs: &[Epoch], parent: bool) -> bool {
    !epochs.is_empty()
        && epochs.len() <= MAX_EPOCHS
        && epochs.iter().all(|e| valid_epoch(e, parent))
        && epochs
            .windows(2)
            .all(|w| w[0].number.checked_add(1) == Some(w[1].number))
}

impl History {
    /// Bootstrap only with authenticated state and an independently established
    /// association. Never use this to recover missing or damaged history.
    #[allow(clippy::too_many_arguments)]
    pub fn bootstrap(
        parent: &[u8],
        channel: &[u8],
        direct: &[u8],
        parent_epoch: u64,
        parent_devices: Vec<Vec<u8>>,
        admins: Vec<Vec<u8>>,
        direct_epoch: u64,
        direct_devices: Vec<Vec<u8>>,
    ) -> Option<Self> {
        let state = Self {
            version: VERSION,
            parent: parent.to_vec(),
            channel: channel.to_vec(),
            direct: direct.to_vec(),
            parents: vec![Epoch {
                number: parent_epoch,
                devices: parent_devices,
                admins,
            }],
            directs: vec![Epoch {
                number: direct_epoch,
                devices: direct_devices,
                admins: vec![],
            }],
            generation: 0,
        };
        state.valid().then_some(state)
    }

    fn valid(&self) -> bool {
        self.version == VERSION
            && self.parent.len() == 16
            && self.channel.len() == 16
            && self.direct.len() == 16
            && self.parent != self.channel
            && self.parent != self.direct
            && self.channel != self.direct
            && valid_sequence(&self.parents, true)
            && valid_sequence(&self.directs, false)
    }

    /// Record every authenticated transition. Full history fails closed; it is
    /// never pruned, including when this prevents further channel operation.
    pub fn record_parent(
        &mut self,
        epoch: u64,
        devices: Vec<Vec<u8>>,
        admins: Vec<Vec<u8>>,
    ) -> bool {
        Self::append(
            &mut self.parents,
            Epoch {
                number: epoch,
                devices,
                admins,
            },
            true,
        )
    }

    pub fn record_direct(&mut self, epoch: u64, devices: Vec<Vec<u8>>) -> bool {
        Self::append(
            &mut self.directs,
            Epoch {
                number: epoch,
                devices,
                admins: vec![],
            },
            false,
        )
    }

    fn append(history: &mut Vec<Epoch>, entry: Epoch, parent: bool) -> bool {
        if history.len() >= MAX_EPOCHS
            || !valid_epoch(&entry, parent)
            || history.last().and_then(|e| e.number.checked_add(1)) != Some(entry.number)
        {
            return false;
        }
        history.push(entry);
        true
    }

    /// Checks an authenticated application epoch and sender. The parent epoch
    /// must be current. A global generation fence is deliberately conservative:
    /// independent senders can block one another, but cannot replay old bindings.
    /// Persist the changed state atomically before publishing acceptance.
    #[allow(clippy::too_many_arguments)]
    pub fn accept(
        &mut self,
        parent: &[u8],
        channel: &[u8],
        direct: &[u8],
        parent_epoch: u64,
        direct_epoch: u64,
        sender: &[u8],
        recipient: &[u8],
        generation: u64,
    ) -> bool {
        if self.parent != parent
            || self.channel != channel
            || self.direct != direct
            || sender.len() != 32
            || recipient.len() != 32
            || sender == recipient
            || generation == 0
            || generation <= self.generation
        {
            return false;
        }
        let Some(p) = self.parents.last().filter(|p| p.number == parent_epoch) else {
            return false;
        };
        let Some(d) = self.directs.iter().find(|d| d.number == direct_epoch) else {
            return false;
        };
        if d.devices.len() != 2
            || !d.devices.iter().any(|x| x == sender)
            || !d.devices.iter().any(|x| x == recipient)
            || !p.devices.iter().any(|x| x == sender)
            || !p.devices.iter().any(|x| x == recipient)
            || !p.admins.iter().any(|x| x == &sender[..16])
        {
            return false;
        }
        self.generation = generation;
        true
    }

    /// Store the snapshot and anchor with the MLS state and acceptance in one
    /// transaction. The anchor requires separate rollback-resistant protection.
    pub fn snapshot(&self) -> Option<(Vec<u8>, [u8; 32])> {
        if !self.valid() {
            return None;
        }
        let bytes = postcard::to_allocvec(self).ok()?;
        if bytes.len() > MAX_SNAPSHOT {
            return None;
        }
        let digest = Sha256::digest(&bytes).into();
        Some((bytes, digest))
    }

    /// Restore only against an independently protected, latest rollback anchor.
    pub fn restore(bytes: &[u8], anchor: &[u8; 32]) -> Option<Self> {
        if bytes.len() > MAX_SNAPSHOT || Sha256::digest(bytes).as_slice() != anchor {
            return None;
        }
        let state: Self = postcard::from_bytes(bytes).ok()?;
        if !state.valid() || postcard::to_allocvec(&state).ok()?.as_slice() != bytes {
            return None;
        }
        Some(state)
    }
}
