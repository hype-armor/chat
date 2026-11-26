use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use chat_server::{AppState, router};
use tower::ServiceExt;

#[tokio::test]
async fn default_state_does_not_register_experimental_presence_routes() {
    let app = router(AppState::default());
    for path in [
        "/v1/experimental/presence/consent",
        "/v1/experimental/presence/generation",
        "/v1/experimental/presence/grant",
        "/v1/experimental/presence/lease",
        "/v1/experimental/presence/poll",
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::post(path)
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
    }
}
