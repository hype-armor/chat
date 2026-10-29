//! Delivery of one-time verification codes (ADR-0011). Real SMS providers
//! plug in behind [`CodeSender`]; `LogSender` is for development only.

use std::{future::Future, pin::Pin};

pub type SendFuture<'a> = Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;

pub trait CodeSender: Send + Sync {
    fn send<'a>(&'a self, phone: &'a str, code: &'a str) -> SendFuture<'a>;
}

/// Writes codes to the server log instead of sending an SMS.
pub struct LogSender;

impl CodeSender for LogSender {
    fn send<'a>(&'a self, phone: &'a str, code: &'a str) -> SendFuture<'a> {
        Box::pin(async move {
            tracing::warn!(%phone, %code, "verification code (log sender: development only)");
            Ok(())
        })
    }
}
