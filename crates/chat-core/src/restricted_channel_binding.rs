//! Experimental validation only. No transport or acceptance path uses this module.
//!
//! The caller must authenticate the direct MLS sender, independently resolve the
//! parent and channel conversations, and obtain current advisory admin state.
//! It must hold the relevant mutation locks and atomically persist the replay
//! fence with acceptance. These requirements are not implemented here. In
//! particular, an invitation cannot establish its own parent/channel association.

pub mod history;

use std::collections::BTreeSet;

use chat_proto::v1::RestrictedChannelBinding;

use crate::mls::{Conversation, IDENTITY_LEN};

/// Independently resolved state, never constructed from the binding claims.
/// `last_generation` is the durable fence for this exact sender, recipient,
/// parent and channel tuple. Missing or rollback-prone storage must not be used.
pub struct BindingContext<'a> {
    pub parent_id: &'a [u8],
    pub channel_id: &'a [u8],
    pub parent: &'a Conversation,
    pub channel: &'a Conversation,
    pub authenticated_sender: &'a [u8],
    pub recipient: &'a [u8],
    /// Current advisory admin account IDs, independently authenticated.
    pub admins: &'a [Vec<u8>],
    pub last_generation: u64,
}

/// Checks a candidate against current MLS state. Success is not authorization
/// to publish: durable replay protection, transactional acceptance and runtime
/// integration remain disabled. Advisory roles do not constrain modified clients.
pub fn validate_binding(binding: &RestrictedChannelBinding, ctx: &BindingContext<'_>) -> bool {
    if ctx.parent_id.len() != 16
        || ctx.channel_id.len() != 16
        || ctx.parent_id == ctx.channel_id
        || binding.parent_conversation_id != ctx.parent_id
        || binding.channel_conversation_id != ctx.channel_id
        || ctx.parent.id() == ctx.channel.id()
        || ctx.authenticated_sender.len() != IDENTITY_LEN
        || ctx.recipient.len() != IDENTITY_LEN
        || ctx.authenticated_sender == ctx.recipient
        || binding.recipient_device != ctx.recipient
        || binding.parent_epoch != ctx.parent.epoch()
        || binding.channel_epoch != ctx.channel.epoch()
        || binding.generation == 0
        || binding.generation <= ctx.last_generation
    {
        return false;
    }
    let Some(parent) = roster(ctx.parent.member_identities()) else {
        return false;
    };
    let Some(channel) = roster(ctx.channel.member_identities()) else {
        return false;
    };
    let Some(claimed_parent) = roster(binding.parent_members.clone()) else {
        return false;
    };
    let Some(claimed_channel) = roster(binding.channel_members.clone()) else {
        return false;
    };
    if parent != claimed_parent
        || channel != claimed_channel
        || !parent.contains(ctx.authenticated_sender)
        || !parent.contains(ctx.recipient)
        || !channel.contains(ctx.authenticated_sender)
        || !channel.contains(ctx.recipient)
        || !channel.is_subset(&parent)
        || ctx.admins.is_empty()
        || ctx.admins.iter().any(|a| a.len() != 16)
        || !ctx
            .admins
            .iter()
            .any(|a| a == &ctx.authenticated_sender[..16])
    {
        return false;
    }
    // Every current parent device of each channel account must be present.
    // This also rejects stale channel devices after parent removal.
    parent.iter().all(|device| {
        !channel.iter().any(|member| member[..16] == device[..16]) || channel.contains(device)
    })
}

fn roster(devices: Vec<Vec<u8>>) -> Option<BTreeSet<Vec<u8>>> {
    if devices.is_empty() {
        return None;
    }
    let mut result = BTreeSet::new();
    for device in devices {
        if device.len() != IDENTITY_LEN || !result.insert(device) {
            return None;
        }
    }
    Some(result)
}
