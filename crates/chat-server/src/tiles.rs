//! Map tiles for areas people share (ADR-0033). The first request for a
//! tile in an area the server doesn't have starts a download of that whole
//! region (one zoom-10 tile, about 40 km across, down to zoom 15) from a
//! PMTiles archive such as Protomaps' daily build; it is kept on disk and
//! served from there. Low-zoom tiles (below 10) are fetched one by one.
//!
//! The upstream learns which regions this server wanted and when, never who
//! asked or the point shared. No tile coordinates are logged.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    body::Body,
    extract::{Path as UrlPath, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::{StreamExt, stream};
use pmtiles::{AsyncPmTilesReader, HashMapCache, HttpBackend, TileCoord};
use serde::Serialize;

use crate::{AppState, auth::AuthDevice, error::ApiError};

/// Regions are zoom-10 tiles.
pub const REGION_ZOOM: u8 = 10;
pub const MAX_ZOOM: u8 = 15;
/// Tiles fetched at once while downloading a region.
const PARALLEL: usize = 8;

/// `CHAT_TILES_DIR` (cache directory), `CHAT_TILES_SOURCE` (archive URL;
/// `{yesterday}` becomes the UTC date before today as YYYYMMDD, for
/// Protomaps' daily builds) and `CHAT_LIMIT_TILES_MAX_REGIONS` (default 500).
#[derive(Clone, Debug, Default)]
pub struct TilesConfig {
    pub dir: Option<PathBuf>,
    pub source: Option<String>,
    pub max_regions: usize,
}

type Reader = AsyncPmTilesReader<HttpBackend, HashMapCache>;

/// The on-demand tile cache.
#[derive(Default)]
pub struct Tiles {
    config: TilesConfig,
    reader: tokio::sync::Mutex<Option<(String, Arc<Reader>)>>,
    downloading: Mutex<HashSet<(u32, u32)>>,
}

#[derive(Serialize)]
pub struct Info {
    /// Areas are downloaded when first asked for.
    on_demand: bool,
    max_zoom: u8,
}

impl Tiles {
    pub fn new(config: TilesConfig) -> Self {
        Self {
            config,
            ..Self::default()
        }
    }

    fn enabled(&self) -> Option<(&Path, &str)> {
        Some((self.config.dir.as_deref()?, self.config.source.as_deref()?))
    }

    fn tile_path(dir: &Path, z: u8, x: u32, y: u32) -> PathBuf {
        dir.join(format!("{z}/{x}/{y}.mvt"))
    }

    fn region_marker(dir: &Path, x: u32, y: u32) -> PathBuf {
        dir.join(format!("regions/{x}-{y}.done"))
    }

    /// The upstream archive, opened once a day (daily builds change name).
    async fn reader(&self, http: &reqwest::Client) -> anyhow::Result<Arc<Reader>> {
        let (_, template) = self.enabled().ok_or_else(|| anyhow::anyhow!("tiles off"))?;
        let url = source_url(template, SystemTime::now());
        let mut slot = self.reader.lock().await;
        if let Some((open, reader)) = slot.as_ref()
            && *open == url
        {
            return Ok(reader.clone());
        }
        let backend = HttpBackend::try_from(http.clone(), url.as_str())?;
        let reader = Arc::new(
            AsyncPmTilesReader::try_from_cached_source(backend, HashMapCache::default()).await?,
        );
        *slot = Some((url, reader.clone()));
        Ok(reader)
    }

    /// Fetches one tile from upstream and stores it (an empty file: no tile there).
    async fn fetch(
        &self,
        reader: &Reader,
        dir: &Path,
        z: u8,
        x: u32,
        y: u32,
    ) -> anyhow::Result<()> {
        let data = reader
            .get_tile_decompressed(TileCoord::new(z, x, y)?)
            .await?
            .unwrap_or_default();
        let path = Self::tile_path(dir, z, x, y);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let tmp = path.with_extension("tmp");
        tokio::fs::write(&tmp, &data).await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }

    /// Downloads a whole region, then marks it done.
    async fn download_region(
        &self,
        http: &reqwest::Client,
        rx: u32,
        ry: u32,
    ) -> anyhow::Result<()> {
        let (dir, _) = self.enabled().ok_or_else(|| anyhow::anyhow!("tiles off"))?;
        let reader = self.reader(http).await?;
        let mut wanted = Vec::new();
        for z in REGION_ZOOM..=MAX_ZOOM {
            let scale = 1u32 << (z - REGION_ZOOM);
            for x in rx * scale..(rx + 1) * scale {
                for y in ry * scale..(ry + 1) * scale {
                    if !Self::tile_path(dir, z, x, y).exists() {
                        wanted.push((z, x, y));
                    }
                }
            }
        }
        let results: Vec<anyhow::Result<()>> = stream::iter(wanted)
            .map(|(z, x, y)| {
                let reader = reader.clone();
                async move { self.fetch(&reader, dir, z, x, y).await }
            })
            .buffer_unordered(PARALLEL)
            .collect()
            .await;
        if let Some(e) = results.into_iter().find_map(Result::err) {
            return Err(e);
        }
        let marker = Self::region_marker(dir, rx, ry);
        tokio::fs::create_dir_all(marker.parent().expect("has a parent")).await?;
        tokio::fs::write(marker, b"").await?;
        Ok(())
    }

    fn regions_done(dir: &Path) -> usize {
        std::fs::read_dir(dir.join("regions")).map_or(0, |d| d.count())
    }
}

/// `{yesterday}` in the source URL: daily builds appear during the day.
pub fn source_url(template: &str, now: SystemTime) -> String {
    let secs = now.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let days = (secs / 86_400).saturating_sub(1) as i64;
    let (y, m, d) = civil_from_days(days);
    template.replace("{yesterday}", &format!("{y:04}{m:02}{d:02}"))
}

/// Days since 1970-01-01 to a calendar date (H. Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `GET /v1/tiles/info`.
pub async fn info(State(state): State<AppState>, AuthDevice(_): AuthDevice) -> Json<Info> {
    Json(Info {
        on_demand: state.tiles.enabled().is_some(),
        max_zoom: MAX_ZOOM,
    })
}

/// `GET /v1/tiles/{z}/{x}/{y}`: a vector tile (decompressed MVT); `204` where
/// the map is empty; `202` with `Retry-After` while its region downloads.
pub async fn tile(
    State(state): State<AppState>,
    AuthDevice(_): AuthDevice,
    UrlPath((z, x, y)): UrlPath<(u8, u32, String)>,
) -> Result<Response, ApiError> {
    let tiles = state.tiles.clone();
    let (dir, _) = tiles
        .enabled()
        .ok_or(ApiError::NotFound("maps are not downloaded on demand here"))?;
    let y: u32 = y
        .strip_suffix(".mvt")
        .unwrap_or(&y)
        .parse()
        .map_err(|_| ApiError::BadRequest("bad tile"))?;
    if z > MAX_ZOOM || x >= 1 << z || y >= 1 << z {
        return Err(ApiError::BadRequest("bad tile"));
    }
    let dir = dir.to_owned();
    let path = Tiles::tile_path(&dir, z, x, y);
    if let Ok(data) = tokio::fs::read(&path).await {
        return Ok(tile_response(data));
    }
    if z < REGION_ZOOM {
        // Coarse tiles: fetched one at a time, straight away.
        let reader = tiles.reader(&state.http).await.map_err(unavailable)?;
        tiles
            .fetch(&reader, &dir, z, x, y)
            .await
            .map_err(unavailable)?;
        let data = tokio::fs::read(&path)
            .await
            .map_err(|e| unavailable(e.into()))?;
        return Ok(tile_response(data));
    }
    let shift = z - REGION_ZOOM;
    let region = (x >> shift, y >> shift);
    if Tiles::region_marker(&dir, region.0, region.1).exists() {
        // Downloaded, but this tile failed then: fetch it now.
        let reader = tiles.reader(&state.http).await.map_err(unavailable)?;
        tiles
            .fetch(&reader, &dir, z, x, y)
            .await
            .map_err(unavailable)?;
        let data = tokio::fs::read(&path)
            .await
            .map_err(|e| unavailable(e.into()))?;
        return Ok(tile_response(data));
    }
    let start = {
        let mut busy = tiles.downloading.lock().expect("not poisoned");
        busy.insert(region)
    };
    if start {
        if Tiles::regions_done(&dir) >= tiles.config.max_regions {
            tiles
                .downloading
                .lock()
                .expect("not poisoned")
                .remove(&region);
            return Err(ApiError::TooManyRequests(
                "this server keeps no more map areas",
            ));
        }
        let http = state.http.clone();
        tokio::spawn(async move {
            if let Err(e) = tiles.download_region(&http, region.0, region.1).await {
                tracing::warn!(error = %e, "downloading a map area failed");
            }
            tiles
                .downloading
                .lock()
                .expect("not poisoned")
                .remove(&region);
        });
    }
    let mut res = (StatusCode::ACCEPTED, "downloading this map area").into_response();
    res.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("3"));
    Ok(res)
}

fn unavailable(e: anyhow::Error) -> ApiError {
    tracing::warn!(error = %e, "map tiles unavailable");
    ApiError::Unavailable
}

fn tile_response(data: Vec<u8>) -> Response {
    if data.is_empty() {
        return StatusCode::NO_CONTENT.into_response();
    }
    let mut res = Response::new(Body::from(data));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.mapbox-vector-tile"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    res
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn daily_build_names() {
        // 2026-11-01T02:00:00Z → yesterday 2026-10-31.
        let now = UNIX_EPOCH + Duration::from_secs(1_793_498_400);
        assert_eq!(
            source_url("https://build.protomaps.com/{yesterday}.pmtiles", now),
            "https://build.protomaps.com/20261031.pmtiles"
        );
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }
}
