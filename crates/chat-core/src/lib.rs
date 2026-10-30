//! Shared client core: identity, MLS conversations, and envelope encoding.
//!
//! Runs natively (tests, future native wrappers) and as WebAssembly in a
//! browser worker (`--features wasm`). See docs/03-architecture.md §3.

pub mod attachment;
pub mod call;
pub mod client;
pub mod envelope;
pub mod mls;
pub mod padding;
pub mod qr;
pub mod safety;
#[cfg(feature = "wasm")]
pub mod wasm;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("mls: {0}")]
    Mls(String),
    #[error("malformed input: {0}")]
    Malformed(&'static str),
    #[error("decode: {0}")]
    Decode(#[from] prost::DecodeError),
}

pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn mls_err(e: impl std::fmt::Debug) -> Error {
    Error::Mls(format!("{e:?}"))
}
