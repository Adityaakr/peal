//! RFC 9457 problem+json, with a stable `code` a client can branch on. Same
//! shape as the coordinator's /v1 so one error handler serves both.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub struct Problem {
    pub status: StatusCode,
    pub code: &'static str,
    pub detail: String,
}

impl Problem {
    pub fn new(status: StatusCode, code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status,
            code,
            detail: detail.into(),
        }
    }
    pub fn bad_request(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, detail)
    }
    pub fn not_found(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, detail)
    }
    pub fn unauthorized(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", detail)
    }
    pub fn conflict(code: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, detail)
    }
    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", detail)
    }
}

impl From<peal_bonsai::Error> for Problem {
    fn from(e: peal_bonsai::Error) -> Self {
        use peal_bonsai::Error as E;
        let detail = e.to_string();
        match e {
            E::Wire(_) | E::NonCanonicalField | E::InvalidPoint => {
                Self::bad_request("malformed", detail)
            }
            E::InvalidProof => Self::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_proof", detail),
            E::UnknownAccount => Self::not_found("unknown_account", detail),
            E::AccountExists => Self::conflict("account_exists", detail),
            E::StaleCommitment => Self::conflict("stale_commitment", detail),
            E::RootNotRecent => Self::conflict("root_not_recent", detail),
            E::ReceiptLogFull => Self::new(StatusCode::SERVICE_UNAVAILABLE, "log_full", detail),
            E::WrongNamespace => Self::bad_request("wrong_namespace", detail),
            E::BadSignature => Self::unauthorized(detail),
            E::Wallet(_) => Self::bad_request("wallet", detail),
            E::Storage(s) if s.contains("already credited") => {
                Self::conflict("duplicate_deposit", s)
            }
            E::Storage(s) => Self::internal(s),
        }
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let body = json!({
            "type": format!("https://peal.network/problems/{}", self.code),
            "title": self.code.replace('_', " "),
            "status": self.status.as_u16(),
            "code": self.code,
            "detail": self.detail,
        });
        (
            self.status,
            [(axum::http::header::CONTENT_TYPE, "application/problem+json")],
            body.to_string(),
        )
            .into_response()
    }
}
