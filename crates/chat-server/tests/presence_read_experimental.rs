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

const CONSENT: &str = "/v1/experimental/presence/consent";
const GENERATION: &str = "/v1/experimental/presence/generation";
const GRANT: &str = "/v1/experimental/presence/grant";

async fn post(state: AppState, path: &str, token: &str, body: Value) -> (StatusCode, Value, bool) {
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
    let no_store = response
        .headers()
        .get("cache-control")
        .is_some_and(|v| v == "no-store");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        no_store,
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
    sqlx::query("INSERT INTO devices (device_id,account_id,identity_key,auth_token_hash) VALUES ($1,$2,$3,$4)")
        .bind(device).bind(account).bind(vec![1_u8]).bind(Sha256::digest(token.as_bytes()).to_vec()).execute(pool).await.unwrap();
    (account, device, token)
}

#[tokio::test]
async fn read_routes_disabled_by_default() {
    for path in [CONSENT, GENERATION] {
        assert_eq!(
            post(AppState::default(), path, "x", json!({})).await.0,
            StatusCode::NOT_FOUND
        );
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn reads_authenticate_and_track_grants(pool: PgPool) {
    let (alice, a, at) = account(&pool).await;
    let (bob, b, bt) = account(&pool).await;
    let (_, c, ct) = account(&pool).await;
    let state = AppState::new(Some(pool.clone())).with_experimental_presence(true);
    let consent = json!({"device_id": a});
    let generation = json!({"device_id": b, "sender": alice});
    assert_eq!(
        post(state.clone(), CONSENT, &bt, consent.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post(state.clone(), GENERATION, &at, generation.clone())
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post(state.clone(), CONSENT, &at, consent.clone()).await,
        (StatusCode::OK, json!({"version":0,"grants":[]}), true)
    );
    assert_eq!(
        post(state.clone(), GENERATION, &bt, generation.clone())
            .await
            .1,
        json!({"generation":null})
    );
    for (expected, enabled) in [(0, true), (1, false), (2, true)] {
        assert_eq!(
            post(
                state.clone(),
                GRANT,
                &at,
                json!({"device_id":a,"recipient":bob,"expected":expected,"enabled":enabled})
            )
            .await
            .0,
            StatusCode::OK
        );
        let grant = if enabled {
            json!([{"recipient":bob,"generation":expected+1}])
        } else {
            json!([])
        };
        assert_eq!(
            post(state.clone(), CONSENT, &at, consent.clone()).await.1,
            json!({"version":expected+1,"grants":grant})
        );
        let current = if enabled {
            json!(expected + 1)
        } else {
            Value::Null
        };
        assert_eq!(
            post(state.clone(), GENERATION, &bt, generation.clone())
                .await
                .1,
            json!({"generation":current})
        );
        assert_eq!(
            post(
                state.clone(),
                GENERATION,
                &ct,
                json!({"device_id":c,"sender":alice})
            )
            .await
            .1,
            json!({"generation":null})
        );
    }
    sqlx::query("DELETE FROM devices WHERE device_id=$1")
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        post(state, CONSENT, &at, consent).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn snapshots_remain_consistent_and_reads_are_rate_limited(pool: PgPool) {
    let (_, a, at) = account(&pool).await;
    let (bob, _, _) = account(&pool).await;
    let state = AppState::new(Some(pool.clone())).with_experimental_presence(true);
    let writer_state = state.clone();
    let writer_token = at.clone();
    let writer = tokio::spawn(async move {
        for expected in 0..40 {
            assert_eq!(post(writer_state.clone(), GRANT, &writer_token, json!({"device_id":a,"recipient":bob,"expected":expected,"enabled":expected % 2 == 0})).await.0, StatusCode::OK);
        }
    });
    for _ in 0..120 {
        let (status, snapshot, no_store) =
            post(state.clone(), CONSENT, &at, json!({"device_id":a})).await;
        assert_eq!(status, StatusCode::OK);
        assert!(no_store);
        let version = snapshot["version"].as_i64().unwrap();
        let expected = if version % 2 == 1 {
            json!([{"recipient":bob,"generation":version}])
        } else {
            json!([])
        };
        assert_eq!(snapshot["grants"], expected);
    }
    writer.await.unwrap();
    assert_eq!(
        post(state, GENERATION, &at, json!({"device_id":a,"sender":bob}))
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}
