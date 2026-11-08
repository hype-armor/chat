//! Local operator commands. Deliberately not exposed through the chat API.
use anyhow::{Context, Result, bail};
use serde_json::json;
use sqlx::{PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

const HELP: &str = "Usage:
  chat-admin migrate
  chat-admin usage [ACCOUNT_UUID]
  chat-admin storage server BYTES|unlimited
  chat-admin storage default BYTES|unlimited
  chat-admin storage account ACCOUNT_UUID BYTES|unlimited|inherit
  chat-admin messages account ACCOUNT_UUID COUNT|inherit

Requires DATABASE_URL with operator database credentials. Run server migrations first.
Sizes are ciphertext bytes, not MiB. Zero blocks new allocations or sends.
Absent account overrides inherit the default. Lowering a quota never deletes data.
Storage includes attachments, backups and reserved uploads, not database or map files.";

#[derive(Debug, PartialEq)]
enum Value {
    Inherit,
    Unlimited,
    Number(i64),
}

fn value(raw: &str, inherit: bool, unlimited: bool) -> Result<Value> {
    match raw {
        "inherit" if inherit => Ok(Value::Inherit),
        "unlimited" if unlimited => Ok(Value::Unlimited),
        _ => {
            let n: i64 = raw.parse().context("expected a nonnegative integer")?;
            if n < 0 {
                bail!("limits must not be negative");
            }
            Ok(Value::Number(n))
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args == ["--help"] || args == ["help"] {
        println!("{HELP}");
        return Ok(());
    }
    // Validate all arguments before opening a connection.
    let command = parse(&args)?;
    let url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let db = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await?;
    run(&db, command).await
}

#[derive(Debug)]
enum Command {
    Migrate,
    Usage(Option<Uuid>),
    StorageGlobal { server: bool, value: Value },
    StorageAccount(Uuid, Value),
    MessagesAccount(Uuid, Value),
}

fn parse(args: &[String]) -> Result<Command> {
    let parts: Vec<&str> = args.iter().map(String::as_str).collect();
    Ok(match parts.as_slice() {
        ["migrate"] => Command::Migrate,
        ["usage"] => Command::Usage(None),
        ["usage", account] => Command::Usage(Some(account.parse()?)),
        ["storage", scope @ ("server" | "default"), raw] => Command::StorageGlobal {
            server: *scope == "server",
            value: value(raw, false, true)?,
        },
        ["storage", "account", account, raw] => {
            Command::StorageAccount(account.parse()?, value(raw, true, true)?)
        }
        ["messages", "account", account, raw] => {
            let v = value(raw, true, false)?;
            if matches!(v, Value::Number(n) if n > i64::from(i32::MAX)) {
                bail!("message limit exceeds {}", i32::MAX);
            }
            Command::MessagesAccount(account.parse()?, v)
        }
        _ => bail!("{HELP}"),
    })
}

async fn run(db: &PgPool, command: Command) -> Result<()> {
    if matches!(command, Command::Migrate) {
        chat_server::migrate(db).await?;
        println!("Database migrations complete.");
        return Ok(());
    }
    if let Command::Usage(account) = command {
        let (server_limit, default_limit): (Option<i64>, Option<i64>) =
            sqlx::query_as("SELECT server_bytes, account_bytes FROM storage_policy WHERE id = 1")
                .fetch_one(db)
                .await?;
        let (used, reserved, objects): (i64, i64, i64) = sqlx::query_as(
            "SELECT coalesce(sum(size_bytes) FILTER (WHERE state = 'live'), 0)::bigint,
                    coalesce(sum(size_bytes) FILTER (WHERE state <> 'live'), 0)::bigint,
                    count(*) FROM storage_objects
             WHERE $1::uuid IS NULL OR account_id = $1",
        )
        .bind(account)
        .fetch_one(db)
        .await?;
        let mut report = json!({
            "account_id": account,
            "charged_bytes": used.checked_add(reserved).context("storage total overflow")?,
            "used_bytes": used,
            "reserved_bytes": reserved,
            "objects_and_reservations": objects,
            "server_limit_bytes": server_limit,
            "default_account_limit_bytes": default_limit,
        });
        if let Some(account) = account {
            require_account(db, account).await?;
            let storage: Option<(Option<i64>,)> = sqlx::query_as(
                "SELECT limit_bytes FROM account_storage_policy WHERE account_id = $1",
            )
            .bind(account)
            .fetch_optional(db)
            .await?;
            let messages: Option<(i32,)> = sqlx::query_as(
                "SELECT sends_per_minute FROM account_send_limits WHERE account_id = $1",
            )
            .bind(account)
            .fetch_optional(db)
            .await?;
            report["storage_override"] = match storage {
                None => json!("inherit"),
                Some((None,)) => json!("unlimited"),
                Some((Some(n),)) => json!(n),
            };
            report["message_limit_override"] = messages.map_or(json!("inherit"), |(n,)| json!(n));
        }
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    let mut tx = db.begin().await?;
    // Use the allocation lock so policy changes and reservations have one order.
    sqlx::query("SELECT id FROM storage_policy WHERE id = 1 FOR UPDATE")
        .fetch_one(&mut *tx)
        .await?;
    match command {
        Command::StorageGlobal { server, value } => {
            let number = match value {
                Value::Unlimited => None,
                Value::Number(n) => Some(n),
                Value::Inherit => unreachable!(),
            };
            let sql = if server {
                "UPDATE storage_policy SET server_bytes = $1 WHERE id = 1"
            } else {
                "UPDATE storage_policy SET account_bytes = $1 WHERE id = 1"
            };
            sqlx::query(sql).bind(number).execute(&mut *tx).await?;
        }
        Command::StorageAccount(account, value) => {
            // Check the target even for an override reset, to catch operator typos.
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM accounts WHERE account_id = $1)")
                    .bind(account)
                    .fetch_one(&mut *tx)
                    .await?;
            if !exists {
                bail!("account does not exist");
            }
            if value == Value::Inherit {
                sqlx::query("DELETE FROM account_storage_policy WHERE account_id = $1")
                    .bind(account)
                    .execute(&mut *tx)
                    .await?;
            } else {
                let number = match value {
                    Value::Number(n) => Some(n),
                    Value::Unlimited => None,
                    Value::Inherit => unreachable!(),
                };
                sqlx::query(
                    "INSERT INTO account_storage_policy(account_id, limit_bytes) VALUES ($1, $2)
                     ON CONFLICT(account_id) DO UPDATE SET limit_bytes = excluded.limit_bytes",
                )
                .bind(account)
                .bind(number)
                .execute(&mut *tx)
                .await?;
            }
        }
        Command::MessagesAccount(account, value) => {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM accounts WHERE account_id = $1)")
                    .bind(account)
                    .fetch_one(&mut *tx)
                    .await?;
            if !exists {
                bail!("account does not exist");
            }
            match value {
                Value::Inherit => {
                    sqlx::query("DELETE FROM account_send_limits WHERE account_id = $1")
                        .bind(account)
                        .execute(&mut *tx)
                        .await?;
                }
                Value::Number(n) => {
                    sqlx::query(
                        "INSERT INTO account_send_limits(account_id, sends_per_minute) VALUES ($1, $2)
                         ON CONFLICT(account_id) DO UPDATE
                         SET sends_per_minute = excluded.sends_per_minute",
                    )
                    .bind(account)
                    .bind(n as i32)
                    .execute(&mut *tx)
                    .await?;
                }
                Value::Unlimited => unreachable!(),
            }
        }
        Command::Migrate | Command::Usage(_) => unreachable!(),
    }
    tx.commit().await?;
    println!("Policy updated. Existing data is unchanged.");
    Ok(())
}

async fn require_account(db: &PgPool, account: Uuid) -> Result<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM accounts WHERE account_id = $1)")
            .bind(account)
            .fetch_one(db)
            .await?;
    if !exists {
        bail!("account does not exist");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn policy_values_are_explicit_and_checked() {
        assert_eq!(value("0", false, true).unwrap(), Value::Number(0));
        assert_eq!(value("unlimited", false, true).unwrap(), Value::Unlimited);
        assert_eq!(value("inherit", true, false).unwrap(), Value::Inherit);
        for invalid in ["-1", "1.5", "1GB", "9223372036854775808"] {
            assert!(value(invalid, true, true).is_err());
        }
        assert!(value("inherit", false, true).is_err());
        assert!(value("unlimited", true, false).is_err());
    }

    #[test]
    fn commands_reject_invalid_targets_and_message_overflow() {
        let account = Uuid::new_v4().to_string();
        assert!(parse(&args(&["usage", &account])).is_ok());
        assert!(parse(&args(&["storage", "server", "unlimited"])).is_ok());
        assert!(parse(&args(&["storage", "account", &account, "inherit"])).is_ok());
        assert!(parse(&args(&["messages", "account", &account, "0"])).is_ok());
        assert!(parse(&args(&["messages", "account", &account, "2147483648"])).is_err());
        assert!(parse(&args(&["messages", "account", &account, "unlimited"])).is_err());
        assert!(parse(&args(&["storage", "account", "not-an-id", "100"])).is_err());
        assert!(parse(&args(&["usage", &account, "extra"])).is_err());
    }
}
