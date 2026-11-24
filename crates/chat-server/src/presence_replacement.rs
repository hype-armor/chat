//! Internal experiment. This is not an authorization or first-use protocol.
//! Rows deliberately have no account/device foreign keys: revocation must not
//! delete replay fences. No route calls this module.
#![allow(dead_code)]

use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

const MAX_GENERATION: i64 = 9_007_199_254_740_991;
const MAX_SCOPES: i64 = 1024;
const MAX_HISTORY: i64 = 1024;

#[derive(Debug)]
pub(crate) enum Error {
    Database(sqlx::Error),
    Unauthorized,
    Conflict,
    Invalid,
    Limited,
}
impl From<sqlx::Error> for Error {
    fn from(value: sqlx::Error) -> Self {
        Self::Database(value)
    }
}

pub(crate) struct Scope<'a> {
    pub device: Uuid,
    pub token: &'a str,
    pub recipient: Uuid,
    pub direct: &'a [u8],
    pub grant_generation: i64,
}

// The device lock serializes scope allocation and device revocation. The grant
// lock serializes the transaction with grant revocation and regrant. Lock order
// matches the existing presence grant operations: device before grant.
async fn authorize(tx: &mut Transaction<'_, Postgres>, scope: &Scope<'_>) -> Result<(), Error> {
    if scope.direct.is_empty()
        || scope.direct.len() > 256
        || scope.grant_generation <= 0
        || scope.grant_generation > MAX_GENERATION
    {
        return Err(Error::Invalid);
    }
    let sender: Uuid = sqlx::query_scalar(
        "SELECT account_id FROM devices WHERE device_id=$1 AND auth_token_hash=$2 FOR UPDATE",
    )
    .bind(scope.device)
    .bind(crate::auth::token_hash(scope.token))
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(Error::Unauthorized)?;
    if sender == scope.recipient {
        return Err(Error::Invalid);
    }
    let grant: Option<i64> = sqlx::query_scalar(
        "SELECT generation FROM presence_grants WHERE sender=$1 AND recipient=$2 FOR SHARE",
    )
    .bind(sender)
    .bind(scope.recipient)
    .fetch_optional(&mut **tx)
    .await?;
    if grant != Some(scope.grant_generation) {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

/// Atomically compare and replace. An operation ID is scoped to one registry row.
/// A retry succeeds only while its exact result remains current.
pub(crate) async fn replace(
    db: &PgPool,
    scope: &Scope<'_>,
    expected: i64,
    generation: i64,
    group: &[u8],
    operation: Uuid,
) -> Result<(), Error> {
    if !(0..MAX_GENERATION).contains(&expected)
        || generation <= expected
        || generation > MAX_GENERATION
        || group.is_empty()
        || group.len() > 256
    {
        return Err(Error::Invalid);
    }
    let mut tx = db.begin().await?;
    authorize(&mut tx, scope).await?;
    let existing: Option<(i64, Option<Vec<u8>>)> = sqlx::query_as("SELECT generation, active_group FROM presence_replacement_scopes WHERE sender_device=$1 AND recipient=$2 AND direct_id=$3 FOR UPDATE")
        .bind(scope.device).bind(scope.recipient).bind(scope.direct).fetch_optional(&mut *tx).await?;
    let (current, active) = if let Some(row) = existing {
        row
    } else {
        if expected != 0 {
            return Err(Error::Conflict);
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM presence_replacement_scopes WHERE sender_device=$1",
        )
        .bind(scope.device)
        .fetch_one(&mut *tx)
        .await?;
        if count >= MAX_SCOPES {
            return Err(Error::Limited);
        }
        sqlx::query("INSERT INTO presence_replacement_scopes (sender_device,recipient,direct_id) VALUES ($1,$2,$3)")
            .bind(scope.device).bind(scope.recipient).bind(scope.direct).execute(&mut *tx).await?;
        (0, None)
    };
    let old: Option<(i64, i64, Vec<u8>)> = sqlx::query_as("SELECT expected,generation,group_id FROM presence_replacement_history WHERE sender_device=$1 AND recipient=$2 AND direct_id=$3 AND operation=$4")
        .bind(scope.device).bind(scope.recipient).bind(scope.direct).bind(operation).fetch_optional(&mut *tx).await?;
    if let Some((old_expected, old_generation, old_group)) = old {
        if (old_expected, old_generation, old_group.as_slice()) != (expected, generation, group)
            || current != generation
            || active.as_deref() != Some(group)
        {
            return Err(Error::Conflict);
        }
        tx.commit().await?;
        return Ok(());
    }
    if current != expected {
        return Err(Error::Conflict);
    }
    let (count, used): (i64, bool) = sqlx::query_as("SELECT count(*), COALESCE(bool_or(group_id=$4),false) FROM presence_replacement_history WHERE sender_device=$1 AND recipient=$2 AND direct_id=$3")
        .bind(scope.device).bind(scope.recipient).bind(scope.direct).bind(group).fetch_one(&mut *tx).await?;
    if used {
        return Err(Error::Conflict);
    }
    if count >= MAX_HISTORY {
        return Err(Error::Limited);
    }
    sqlx::query("INSERT INTO presence_replacement_history (sender_device,recipient,direct_id,operation,expected,generation,group_id) VALUES ($1,$2,$3,$4,$5,$6,$7)")
        .bind(scope.device).bind(scope.recipient).bind(scope.direct).bind(operation).bind(expected).bind(generation).bind(group).execute(&mut *tx).await?;
    sqlx::query("UPDATE presence_replacement_scopes SET generation=$4,active_group=$5 WHERE sender_device=$1 AND recipient=$2 AND direct_id=$3")
        .bind(scope.device).bind(scope.recipient).bind(scope.direct).bind(generation).bind(group).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// A point-in-time check only. It does not authorize later use.
pub(crate) async fn validate(
    db: &PgPool,
    scope: &Scope<'_>,
    generation: i64,
    group: &[u8],
) -> Result<bool, Error> {
    if !(1..=MAX_GENERATION).contains(&generation) || group.is_empty() || group.len() > 256 {
        return Err(Error::Invalid);
    }
    let mut tx = db.begin().await?;
    authorize(&mut tx, scope).await?;
    let found: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM presence_replacement_scopes WHERE sender_device=$1 AND recipient=$2 AND direct_id=$3 AND generation=$4 AND active_group=$5)")
        .bind(scope.device).bind(scope.recipient).bind(scope.direct).bind(generation).bind(group).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(found)
}

#[cfg(test)]
mod tests;
