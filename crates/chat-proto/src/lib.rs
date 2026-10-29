//! Wire types generated from `proto/chat/v1/*.proto`.

// Generated code: frames are short-lived, so boxing the larger variants
// would only add allocations.
#[allow(clippy::large_enum_variant)]
pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/chat.v1.rs"));
}

/// Protocol version carried in every [`v1::Envelope`].
pub const PROTOCOL_VERSION: u32 = 1;
