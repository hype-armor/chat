//! Experimental replacement acceptance. This is not a transport or a consent source.
//! Persist the fence atomically with MLS state before using an accepted group.

/// Values carried inside an authenticated application message.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Binding {
    pub direct_conversation: Vec<u8>,
    pub presence_conversation: Vec<u8>,
    pub recipient_account: Vec<u8>,
    pub consent_generation: u64,
    pub replacement_generation: u64,
    /// Exact MLS identities (account ID followed by device ID).
    pub members: Vec<Vec<u8>>,
}

/// The caller obtains these values independently of the encrypted body.
/// Capture and revalidate them under the MLS mutation lock. `sender` must come
/// from MLS application authentication, never from an envelope or body.
pub struct Context<'a> {
    pub sender: &'a [u8],
    pub sender_account: &'a [u8],
    pub recipient_account: &'a [u8],
    pub recipient_device: &'a [u8],
    pub direct_conversation: &'a [u8],
    /// None means a revoked or unavailable grant, not an empty audience.
    pub consent_generation: Option<u64>,
    /// Current authorized device identities for both accounts.
    pub authorized_members: &'a [Vec<u8>],
    /// Roster obtained from the joined replacement MLS group.
    pub group_members: &'a [Vec<u8>],
    pub group_id: &'a [u8],
}

/// Store one fence per sender device, recipient account and direct conversation.
/// Never discard it on revocation or transient errors. Restoring an old fence
/// can admit a replay, so durable rollback protection is a release blocker.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReplacementFence {
    pub generation: u64,
    pub group_id: Vec<u8>,
    /// Every accepted group ID for this fence, including the current group.
    /// Never truncate this list: exhausting the limit must fail closed.
    pub used_group_ids: Vec<Vec<u8>>,
}

const MAX_USED_GROUP_IDS: usize = 4096;

fn canonical(members: &[Vec<u8>]) -> Option<Vec<Vec<u8>>> {
    if members.is_empty() || members.iter().any(|id| id.len() != 32) {
        return None;
    }
    let mut result = members.to_vec();
    result.sort();
    if result.windows(2).any(|pair| pair[0] == pair[1]) {
        return None;
    }
    Some(result)
}

/// Validate a replacement after MLS authentication and group join. A `Some`
/// result is a proposed fence, not permission to send until it and the MLS
/// state are durably committed together and the context is revalidated.
pub fn accept_replacement(
    binding: &Binding,
    context: &Context<'_>,
    fence: &ReplacementFence,
) -> Option<ReplacementFence> {
    let members = canonical(&binding.members)?;
    let authorized = canonical(context.authorized_members)?;
    let actual = canonical(context.group_members)?;
    // A malformed or incomplete restored fence cannot safely authorize a join.
    let mut used = fence.used_group_ids.clone();
    used.sort();
    if used.len() >= MAX_USED_GROUP_IDS
        || used.iter().any(|id| id.len() != 16)
        || used.windows(2).any(|pair| pair[0] == pair[1])
        || (fence.generation == 0 && (!fence.group_id.is_empty() || !used.is_empty()))
        || (fence.generation != 0
            && (fence.group_id.len() != 16 || !used.contains(&fence.group_id)))
    {
        return None;
    }
    if context.sender.len() != 32
        || context.sender_account.len() != 16
        || context.recipient_account.len() != 16
        || context.recipient_device.len() != 32
        || context.sender[..16] != *context.sender_account
        || context.recipient_device[..16] != *context.recipient_account
        || context.sender_account == context.recipient_account
        || context.direct_conversation.len() != 16
        || context.group_id.len() != 16
        || context.group_id == context.direct_conversation
        || binding.direct_conversation != context.direct_conversation
        || binding.presence_conversation != context.group_id
        || binding.recipient_account != context.recipient_account
        || context.consent_generation != Some(binding.consent_generation)
        || binding.consent_generation == 0
        || binding.replacement_generation <= fence.generation
        || used.iter().any(|id| id == context.group_id)
        || members != authorized
        || members != actual
        || !members.iter().any(|id| id == context.sender)
        || !members.iter().any(|id| id == context.recipient_device)
        || members
            .iter()
            .any(|id| id[..16] != *context.sender_account && id[..16] != *context.recipient_account)
    {
        return None;
    }
    used.push(context.group_id.to_vec());
    Some(ReplacementFence {
        generation: binding.replacement_generation,
        group_id: context.group_id.to_vec(),
        used_group_ids: used,
    })
}
