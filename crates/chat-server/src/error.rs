use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};

/// Errors returned by REST handlers as `{"error": "..."}`.
#[derive(Debug)]
pub enum ApiError {
    BadRequest(&'static str),
    Unauthorized(&'static str),
    Forbidden(&'static str),
    NotFound(&'static str),
    Conflict(&'static str),
    TooManyRequests(&'static str),
    /// A `Range` outside a blob of this many bytes.
    RangeNotSatisfiable(u64),
    /// No database configured or reachable.
    Unavailable,
    Internal(anyhow::Error),
}

impl ApiError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::RangeNotSatisfiable(_) => StatusCode::RANGE_NOT_SATISFIABLE,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::BadRequest(m)
            | Self::Forbidden(m)
            | Self::Unauthorized(m)
            | Self::NotFound(m)
            | Self::Conflict(m)
            | Self::TooManyRequests(m) => m,
            Self::RangeNotSatisfiable(_) => "range not satisfiable",
            Self::Unavailable => "service unavailable",
            Self::Internal(_) => "internal error",
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        Self::Internal(e.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if let Self::Internal(e) = &self {
            tracing::error!(error = %e, "request failed");
        }
        let mut response = (
            self.status(),
            Json(serde_json::json!({ "error": self.message() })),
        )
            .into_response();
        if let Self::RangeNotSatisfiable(size) = self {
            response.headers_mut().insert(
                axum::http::header::CONTENT_RANGE,
                format!("bytes */{size}").parse().expect("ascii"),
            );
        }
        response
    }
}
