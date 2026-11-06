//! Map tile reads are limited per device (ADR-0033, FR-SAF-2), from a local
//! stand-in for Protomaps' archive.
mod support;

use std::{io::Cursor, sync::Arc};

use axum::{
    Router,
    body::Body,
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::get,
};
use chat_server::{
    limits::Limits,
    tiles::{Tiles, TilesConfig},
};
use pmtiles::{PmTilesWriter, TileCoord, TileType};
use sqlx::PgPool;
use support::TestServer;

/// A small archive: one world tile at zoom 0 and one street-level tile.
fn archive() -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    let mut w = PmTilesWriter::new(TileType::Mvt)
        .max_zoom(15)
        .create(&mut out)
        .unwrap();
    w.add_tile(TileCoord::new(0, 0, 0).unwrap(), b"world")
        .unwrap();
    w.add_tile(TileCoord::new(12, 1200, 1600).unwrap(), b"street")
        .unwrap();
    w.finalize().unwrap();
    out.into_inner()
}

/// Serves the archive with HTTP range requests, as a CDN would.
async fn upstream() -> String {
    let data = Arc::new(archive());
    let app = Router::new().route(
        "/build.pmtiles",
        get(move |headers: HeaderMap| {
            let data = data.clone();
            async move {
                let range = headers[header::RANGE]
                    .to_str()
                    .unwrap()
                    .trim_start_matches("bytes=");
                let (a, b) = range.split_once('-').unwrap();
                let (a, b): (usize, usize) = (a.parse().unwrap(), b.parse().unwrap());
                let b = b.min(data.len() - 1);
                Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {a}-{b}/{}", data.len()),
                    )
                    .body(Body::from(data[a..=b].to_vec()))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/build.pmtiles", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    url
}

#[sqlx::test]
async fn tile_reads_are_limited_per_device(pool: PgPool) {
    let mut server = TestServer::start_with_limits(
        pool,
        Limits {
            tile_areas_per_hour: 1,
            tile_reads_per_minute: 2,
            ..Limits::default()
        },
    )
    .await;
    let (_, token) = server.register("u5550009101.10").await;

    let dir = std::env::temp_dir().join(format!("chat-tiles-{}", uuid::Uuid::new_v4()));
    server.state.tiles = Arc::new(Tiles::new(TilesConfig {
        dir: Some(dir.clone()),
        source: Some(upstream().await),
        max_regions: 10,
    }));

    let (status, body) = server.get("/v1/tiles/info", Some(&token)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["on_demand"], true);

    // Two reads a minute: both go through, even though the area is still
    // downloading (202) or already here (200).
    let (status, _) = server
        .raw("GET", "/v1/tiles/10/1/1.mvt", &token, vec![])
        .await;
    assert_eq!(status, 202, "the first read starts the area download");
    let (status, _) = server
        .raw("GET", "/v1/tiles/10/1/1.mvt", &token, vec![])
        .await;
    assert_ne!(status, 429, "the second read is still allowed");

    let (status, _) = server
        .raw("GET", "/v1/tiles/10/1/1.mvt", &token, vec![])
        .await;
    assert_eq!(status, 429, "the third read in a minute is refused");

    std::fs::remove_dir_all(dir).ok();
}
