//! Per-request correlation ids and tracing spans for the HTTP API.
//!
//! Every response carries an `X-Request-Id` header, and the request runs
//! inside a span carrying `request_id`, `method`, `route`, `status` and
//! `duration_seconds`. A slow request can therefore be followed from its
//! header in a bug report to its span and log lines.

use std::time::Instant;

use axum::extract::{MatchedPath, Request};
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;
use tracing::Instrument;

/// Correlation id attached to a request and returned in a response header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestId(pub String);

/// Header name used for the correlation id.
pub const REQUEST_ID_HEADER: &str = "x-request-id";

/// Generates 128 bits of OS randomness as lowercase hex.
///
/// `getrandom` is already a dependency (the API-key generator uses it), so
/// this adds no crate to the indexer.
pub fn new_request_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the OS random source is unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Collapses id-like segments in a path so the `route` label stays bounded.
///
/// Normally the `MatchedPath` extension supplies the route template. This is
/// the fallback for unmatched and middleware-generated responses, where no
/// template exists.
pub fn normalise_path(path: &str) -> String {
    let segments: Vec<String> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            if segment.chars().all(|c| c.is_ascii_digit()) || segment.len() >= 24 {
                ":id".to_string()
            } else {
                segment.to_string()
            }
        })
        .collect();
    if segments.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", segments.join("/"))
    }
}

/// Middleware that assigns a request id, wraps the request in a span, and
/// returns the id in the response header.
pub async fn trace_requests(mut request: Request, next: Next) -> Response {
    let id = new_request_id();
    let method = request.method().to_string();
    // `MatchedPath` is set by the router before middleware added with
    // `Router::layer` runs, so matched requests use the route template rather
    // than the concrete path.
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_owned())
        .unwrap_or_else(|| normalise_path(request.uri().path()));

    let span = tracing::info_span!(
        "api_request",
        request_id = %id,
        method = %method,
        route = %route,
        status = tracing::field::Empty,
        duration_seconds = tracing::field::Empty,
    );
    request.extensions_mut().insert(RequestId(id.clone()));

    let started = Instant::now();
    let mut response = next.run(request).instrument(span.clone()).await;
    let status = response.status().as_u16();
    span.record("status", status as u64);
    span.record("duration_seconds", started.elapsed().as_secs_f64());

    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert(REQUEST_ID_HEADER, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    #[test]
    fn request_ids_are_unique_hex_strings() {
        let first = new_request_id();
        let second = new_request_id();
        assert_eq!(first.len(), 32);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        assert_ne!(first, second);
    }

    #[test]
    fn normalise_path_collapses_id_like_segments() {
        assert_eq!(normalise_path("/v1/tasks/42"), "/v1/tasks/:id");
        assert_eq!(
            normalise_path("/v1/tasks/CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            "/v1/tasks/:id"
        );
        assert_eq!(normalise_path("/v1/tasks"), "/v1/tasks");
        assert_eq!(normalise_path("/"), "/");
    }

    #[tokio::test]
    async fn every_response_gets_a_header_matching_the_extension() {
        async fn handler(request: Request) -> String {
            request
                .extensions()
                .get::<RequestId>()
                .expect("middleware inserted a request id")
                .0
                .clone()
        }

        let app = Router::new()
            .route("/v1/tasks/{id}", get(handler))
            .layer(axum::middleware::from_fn(trace_requests));

        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v1/tasks/42")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let header = response
            .headers()
            .get(REQUEST_ID_HEADER)
            .expect("request id header")
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(header.len(), 32);

        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(String::from_utf8(body.to_vec()).unwrap(), header);
    }
}
