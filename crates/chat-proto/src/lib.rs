//! Wire types generated from `proto/chat/v1/*.proto`.

pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/chat.v1.rs"));
}

/// Protocol version carried in every [`v1::Envelope`].
pub const PROTOCOL_VERSION: u32 = 1;
