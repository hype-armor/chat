//! Map areas downloaded on demand (ADR-0033), from a local stand-in for
//! Protomaps' archive.
mod support;

use std::{io::Cursor, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::get,
};
use chat_server::tiles::{Tiles, TilesConfig};
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
async fn areas_download_when_first_asked_for(pool: PgPool) {
    let mut server = TestServer::start(pool).await;
    let (_, token) = server.register("u5550008001.10").await;
    let (status, _) = server.raw("GET", "/v1/tiles/0/0/0", &token, vec![]).await;
    assert_eq!(status, 404, "off until configured");

    let dir = std::env::temp_dir().join(format!("chat-tiles-{}", uuid::Uuid::new_v4()));
    server.state.tiles = Arc::new(Tiles::new(TilesConfig {
        dir: Some(dir.clone()),
        source: Some(upstream().await),
        max_regions: 10,
    }));

    // Coarse tiles come straight away.
    let (status, body) = server.raw("GET", "/v1/tiles/0/0/0", &token, vec![]).await;
    assert_eq!((status, body.as_slice()), (200, b"world".as_slice()));

    // Street level: the first request starts the area's download…
    let (status, _) = server
        .raw("GET", "/v1/tiles/12/1200/1600", &token, vec![])
        .await;
    assert_eq!(status, 202);
    // …and soon the whole area is here, tiles and empty places alike.
    let mut got = (0, vec![]);
    for _ in 0..100 {
        got = server
            .raw("GET", "/v1/tiles/12/1200/1600", &token, vec![])
            .await;
        if got.0 != 202 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!((got.0, got.1.as_slice()), (200, b"street".as_slice()));
    // Tiles are served as they arrive; the area is done a moment later.
    for _ in 0..100 {
        if dir.join("regions/300-400.done").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let (status, _) = server
        .raw("GET", "/v1/tiles/15/9601/12801", &token, vec![])
        .await;
    assert_eq!(
        status, 204,
        "an empty place in the same area, already downloaded"
    );
    assert!(dir.join("regions/300-400.done").exists());

    let (status, _) = server.raw("GET", "/v1/tiles/16/0/0", &token, vec![]).await;
    assert_eq!(status, 400);
    let (status, _) = server.raw("GET", "/v1/tiles/3/9/0", &token, vec![]).await;
    assert_eq!(status, 400);
    std::fs::remove_dir_all(dir).ok();
}
