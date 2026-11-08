//! Operator commands use the test database, never a deployment.
use serde_json::Value;
use sqlx::{ConnectOptions, PgPool};
use std::process::Command;
use uuid::Uuid;

async fn admin(pool: &PgPool, args: &[&str]) -> std::process::Output {
    // sqlx::test gives each test a private database. Build the URL from its
    // connection options, not the outer DATABASE_URL database name.
    let url = pool.connect_options().to_url_lossy().to_string();
    Command::new(env!("CARGO_BIN_EXE_chat-admin"))
        .env("DATABASE_URL", url)
        .args(args)
        .output()
        .unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn operator_manages_storage_and_message_overrides(pool: PgPool) {
    let account = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts(account_id, username) VALUES ($1, 'quota-operator-test')")
        .bind(account)
        .execute(&pool)
        .await
        .unwrap();
    let id = account.to_string();
    let migrated = admin(&pool, &["migrate"]).await;
    assert!(
        migrated.status.success(),
        "{}",
        String::from_utf8_lossy(&migrated.stderr)
    );
    for args in [
        vec!["storage", "server", "10000"],
        vec!["storage", "default", "5000"],
        vec!["storage", "account", &id, "2000"],
        vec!["messages", "account", &id, "10"],
    ] {
        let output = admin(&pool, &args).await;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let report: Value =
        serde_json::from_slice(&admin(&pool, &["usage", &id]).await.stdout).unwrap();
    assert_eq!(report["server_limit_bytes"], 10000);
    assert_eq!(report["default_account_limit_bytes"], 5000);
    assert_eq!(report["storage_override"], 2000);
    assert_eq!(report["message_limit_override"], 10);
    assert_eq!(report["charged_bytes"], 0);
    sqlx::query("INSERT INTO storage_objects(object_key, account_id, size_bytes, state) VALUES ('pending-test', $1, 5, 'reserved'), ('stored-test', $1, 7, 'live')")
        .bind(account)
        .execute(&pool)
        .await
        .unwrap();
    let totals: Value =
        serde_json::from_slice(&admin(&pool, &["usage", &id]).await.stdout).unwrap();
    assert_eq!(totals["charged_bytes"], 12);
    assert_eq!(totals["used_bytes"], 7);
    assert_eq!(totals["reserved_bytes"], 5);
    assert!(
        admin(&pool, &["storage", "account", &id, "unlimited"])
            .await
            .status
            .success()
    );
    let report: Value =
        serde_json::from_slice(&admin(&pool, &["usage", &id]).await.stdout).unwrap();
    assert_eq!(report["storage_override"], "unlimited");
    assert!(
        admin(&pool, &["storage", "account", &id, "inherit"])
            .await
            .status
            .success()
    );
    assert!(
        admin(&pool, &["messages", "account", &id, "inherit"])
            .await
            .status
            .success()
    );
    let report: Value =
        serde_json::from_slice(&admin(&pool, &["usage", &id]).await.stdout).unwrap();
    assert_eq!(report["storage_override"], "inherit");
    assert_eq!(report["message_limit_override"], "inherit");
}

#[sqlx::test(migrations = "./migrations")]
async fn operator_rejects_missing_accounts_and_invalid_values(pool: PgPool) {
    let missing = Uuid::new_v4().to_string();
    for args in [
        vec!["storage", "account", &missing, "100"],
        vec!["storage", "account", &missing, "inherit"],
        vec!["messages", "account", &missing, "0"],
        vec!["usage", &missing],
        vec!["storage", "server", "-1"],
        vec!["messages", "account", &missing, "2147483648"],
    ] {
        let output = admin(&pool, &args).await;
        assert!(!output.status.success(), "accepted {args:?}");
    }
}
