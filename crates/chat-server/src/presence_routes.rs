//! Experimental polling transport. Ciphertext is opaque and never enters the queue.
use crate::{AppState, auth, error::ApiError, presence};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, header::AUTHORIZATION},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub(crate) struct SafeJson<T>(T);
impl<S: Send + Sync, T: serde::de::DeserializeOwned> axum::extract::FromRequest<S> for SafeJson<T> {
    type Rejection = ApiError;
    async fn from_request(req: axum::extract::Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|_| ApiError::BadRequest("invalid request body"))
    }
}

pub async fn no_store(mut response: axum::response::Response) -> axum::response::Response {
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

#[derive(Deserialize)]
pub struct Grant {
    device_id: Uuid,
    recipient: Uuid,
    expected: i64,
    enabled: bool,
}
#[derive(Deserialize)]
pub struct Lease {
    device_id: Uuid,
    recipient: Uuid,
    generation: i64,
    ciphertext: String,
}
#[derive(Deserialize)]
pub struct ConsentRequest {
    device_id: Uuid,
}
#[derive(Deserialize)]
pub struct Poll {
    device_id: Uuid,
    sender: Uuid,
}
#[derive(Serialize)]
pub struct Version {
    version: i64,
}
#[derive(Serialize)]
pub struct Consent {
    version: i64,
    grants: Vec<ConsentGrant>,
}
#[derive(Serialize)]
pub struct ConsentGrant {
    recipient: Uuid,
    generation: i64,
}
#[derive(Serialize)]
pub struct Generation {
    generation: Option<i64>,
}
#[derive(Serialize)]
pub struct Entry {
    device_id: Uuid,
    generation: i64,
    ciphertext: String,
}

fn token(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty())
        .ok_or(ApiError::Unauthorized("missing bearer token"))
}
fn error(e: presence::Error) -> ApiError {
    match e {
        presence::Error::Database(_) => ApiError::Unavailable,
        presence::Error::Unauthorized => ApiError::Unauthorized("presence authorization failed"),
        presence::Error::Conflict => ApiError::Conflict("presence version conflict"),
        presence::Error::Invalid => ApiError::BadRequest("invalid presence request"),
        presence::Error::Limited => ApiError::TooManyRequests("presence limit reached"),
    }
}
pub async fn grant(
    State(state): State<AppState>,
    headers: HeaderMap,
    SafeJson(req): SafeJson<Grant>,
) -> Result<Json<Version>, ApiError> {
    let version = presence::set_grant(
        auth::db(&state)?,
        req.device_id,
        token(&headers)?,
        req.recipient,
        req.expected,
        req.enabled,
    )
    .await
    .map_err(error)?;
    Ok(Json(Version { version }))
}
pub async fn consent(
    State(state): State<AppState>,
    headers: HeaderMap,
    SafeJson(req): SafeJson<ConsentRequest>,
) -> Result<Json<Consent>, ApiError> {
    let (version, grants) = presence::consent(auth::db(&state)?, req.device_id, token(&headers)?)
        .await
        .map_err(error)?;
    Ok(Json(Consent {
        version,
        grants: grants
            .into_iter()
            .map(|(recipient, generation)| ConsentGrant {
                recipient,
                generation,
            })
            .collect(),
    }))
}

pub async fn generation(
    State(state): State<AppState>,
    headers: HeaderMap,
    SafeJson(req): SafeJson<Poll>,
) -> Result<Json<Generation>, ApiError> {
    let generation = presence::generation(
        auth::db(&state)?,
        req.device_id,
        token(&headers)?,
        req.sender,
    )
    .await
    .map_err(error)?;
    Ok(Json(Generation { generation }))
}

pub async fn lease(
    State(state): State<AppState>,
    headers: HeaderMap,
    SafeJson(req): SafeJson<Lease>,
) -> Result<(), ApiError> {
    let db = auth::db(&state)?;
    let bearer = token(&headers)?;
    let bytes = match STANDARD.decode(req.ciphertext) {
        Ok(bytes) => bytes,
        Err(_) => {
            presence::rate(db, req.device_id, bearer, "write", 120)
                .await
                .map_err(error)?;
            return Err(ApiError::BadRequest("invalid ciphertext"));
        }
    };
    presence::publish(
        db,
        req.device_id,
        bearer,
        req.recipient,
        req.generation,
        &bytes,
    )
    .await
    .map_err(error)
}
pub async fn poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    SafeJson(req): SafeJson<Poll>,
) -> Result<Json<Vec<Entry>>, ApiError> {
    let rows = presence::poll(
        auth::db(&state)?,
        req.device_id,
        token(&headers)?,
        req.sender,
    )
    .await
    .map_err(error)?;
    Ok(Json(
        rows.into_iter()
            .map(|(device_id, generation, ciphertext)| Entry {
                device_id,
                generation,
                ciphertext: STANDARD.encode(ciphertext),
            })
            .collect(),
    ))
}
