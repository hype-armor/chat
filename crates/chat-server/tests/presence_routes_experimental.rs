use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use chat_server::{AppState, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

async fn post(state: AppState, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let response = router(state)
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn account(pool: &PgPool) -> (Uuid, Uuid, String) {
    let account = Uuid::new_v4();
    let device = Uuid::new_v4();
    let token = device.to_string();
    sqlx::query("INSERT INTO accounts (account_id,username) VALUES ($1,$2)")
        .bind(account)
        .bind(account.to_string())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO devices (device_id,account_id,identity_key,auth_token_hash) VALUES ($1,$2,$3,$4)").bind(device).bind(account).bind(vec![1_u8]).bind(Sha256::digest(token.as_bytes()).to_vec()).execute(pool).await.unwrap();
    (account, device, token)
}
const GRANT: &str = "/v1/experimental/presence/grant";
const LEASE: &str = "/v1/experimental/presence/lease";
const POLL: &str = "/v1/experimental/presence/poll";

#[tokio::test]
async fn disabled_by_default() {
    assert_eq!(
        post(AppState::default(), POLL, "x", json!({})).await.0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn authorization_revocation_expiry_and_deletion(pool: PgPool) {
    let (alice, a, at) = account(&pool).await;
    let (bob, b, bt) = account(&pool).await;
    let (_, c, ct) = account(&pool).await;
    let state = AppState::new(Some(pool.clone())).with_experimental_presence(true);
    let grant = |expected, enabled| json!({"device_id": a, "recipient": bob, "expected": expected, "enabled": enabled});
    let poll = |device_id| json!({"device_id": device_id, "sender": alice});
    let lease =
        json!({"device_id": a, "recipient": bob, "generation": 1, "ciphertext": "Y2lwaGVy"});
    assert_eq!(
        post(state.clone(), GRANT, &bt, grant(0, true)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post(state.clone(), GRANT, &at, grant(0, true)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        post(state.clone(), LEASE, &at, lease.clone()).await.0,
        StatusCode::OK
    );
    assert_eq!(post(state.clone(), POLL, &ct, poll(c)).await.1, json!([]));
    assert_eq!(
        post(state.clone(), POLL, &bt, poll(b)).await.1,
        json!([{"device_id": a, "generation": 1, "ciphertext":"Y2lwaGVy"}])
    );
    sqlx::query("UPDATE presence_leases SET expires_at=clock_timestamp()-interval '1 second'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(post(state.clone(), POLL, &bt, poll(b)).await.1, json!([]));
    assert_eq!(
        post(state.clone(), LEASE, &at, lease.clone()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        post(state.clone(), GRANT, &at, grant(1, false)).await.0,
        StatusCode::OK
    );
    assert_eq!(post(state.clone(), POLL, &bt, poll(b)).await.1, json!([]));
    assert_eq!(
        post(state.clone(), LEASE, &at, lease).await.0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("DELETE FROM devices WHERE device_id=$1")
        .bind(b)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        post(state.clone(), POLL, &bt, poll(b)).await.0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("DELETE FROM accounts WHERE account_id=$1")
        .bind(alice)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        post(state, GRANT, &at, grant(2, true)).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn route_poll_races_revocation(pool: PgPool) {
    let (alice, a, at) = account(&pool).await;
    let (bob, b, bt) = account(&pool).await;
    let state = AppState::new(Some(pool.clone())).with_experimental_presence(true);
    let grant = |expected, enabled| json!({"device_id": a, "recipient": bob, "expected": expected, "enabled": enabled});
    assert_eq!(
        post(state.clone(), GRANT, &at, grant(0, true)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        post(
            state.clone(),
            LEASE,
            &at,
            json!({"device_id": a, "recipient": bob, "generation": 1, "ciphertext": "Yw=="})
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut polls = Vec::new();
    for _ in 0..12 {
        let state = state.clone();
        let token = bt.clone();
        polls.push(tokio::spawn(async move {
            post(
                state,
                POLL,
                &token,
                json!({"device_id": b, "sender": alice}),
            )
            .await
        }));
    }
    assert_eq!(
        post(state.clone(), GRANT, &at, grant(1, false)).await.0,
        StatusCode::OK
    );
    for poll in polls {
        let (status, value) = poll.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert!(
            value == json!([])
                || value == json!([{"device_id": a, "generation": 1, "ciphertext": "Yw=="}])
        );
    }
    for _ in 0..5 {
        assert_eq!(
            post(
                state.clone(),
                POLL,
                &bt,
                json!({"device_id": b, "sender": alice})
            )
            .await
            .1,
            json!([])
        );
    }
}
