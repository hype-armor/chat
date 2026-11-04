//! Map tiles for areas people share (ADR-0033). The first request for a
//! tile in an area the server doesn't have starts a download of that whole
//! region (one zoom-10 tile, about 40 km across, down to zoom 15) from a
//! PMTiles archive such as Protomaps' daily build; it is kept on disk and
//! served from there. Low-zoom tiles (below 10) are fetched one by one.
//!
//! The upstream learns which regions this server wanted and when, never who
//! asked or the point shared. No tile coordinates are logged.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
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

use crate::{
    AppState,
    auth::AuthDevice,
    error::ApiError,
    limits::{self, HOUR},
};

/// Regions are zoom-10 tiles.
pub const REGION_ZOOM: u8 = 10;
pub const MAX_ZOOM: u8 = 15;
/// Tiles fetched at once while downloading a region.
const PARALLEL: usize = 8;
/// Areas downloading at once. Each one is ~1,365 tile fetches: without this
/// cap, one client asking for many areas turns the server into a downloader.
const MAX_CONCURRENT_REGIONS: usize = 4;

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
pub struct Tiles {
    config: TilesConfig,
    /// Its own client: slow links need longer than the server's 10 s API timeout.
    http: reqwest::Client,
    reader: tokio::sync::Mutex<Option<(String, Arc<Reader>)>>,
    downloading: Mutex<HashSet<(u32, u32)>>,
    /// Bounds concurrent region downloads (`MAX_CONCURRENT_REGIONS`).
    slots: Arc<tokio::sync::Semaphore>,
    /// When each area was last used, for eviction. In memory only: no file is
    /// opened on the strength of a request's tile coordinates.
    used: Mutex<HashMap<(u32, u32), SystemTime>>,
}

#[derive(Serialize)]
pub struct Info {
    /// Areas are downloaded when first asked for.
    on_demand: bool,
    max_zoom: u8,
}

impl Tiles {
    pub fn new(config: TilesConfig) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("HTTP client");
        Self {
            config,
            http,
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_REGIONS)),
            ..Self::default()
        }
    }

    fn enabled(&self) -> Option<(&Path, &str)> {
        Some((self.config.dir.as_deref()?, self.config.source.as_deref()?))
    }

    fn tile_path(dir: &Path, z: u8, x: u32, y: u32) -> PathBuf {
        dir.join(format!("{z}/{x}/{y}.mvt"))
    }

    /// Lexical containment: a path the cache keeps must stay inside `dir`.
    /// The components are integers that the route parses and bounds before
    /// they get here, so this never fails today; it pins the invariant in
    /// one place the details (and scanners) can check.
    fn contained(dir: &Path, path: &Path) -> bool {
        path.starts_with(dir)
    }

    /// The cache file name for a tile, `None` if the name holds path
    /// traversal syntax. The route bounds `z`, `x` and `y` to fit the zoom,
    /// so the digits and separators are all this can produce; the check
    /// makes that invariant explicit in a shape scanners recognize.
    fn tile_file_name(z: u8, x: u32, y: u32) -> Option<String> {
        let file = format!("{z}/{x}/{y}.mvt");
        if file.contains("..") {
            None
        } else {
            Some(file)
        }
    }

    /// As [`Self::tile_file_name`], for a region's done-marker.
    fn region_file_name(x: u32, y: u32) -> Option<String> {
        let file = format!("regions/{x}-{y}.done");
        if file.contains("..") {
            None
        } else {
            Some(file)
        }
    }

    /// The upstream archive, opened once a day (daily builds change name).
    async fn reader(&self) -> anyhow::Result<Arc<Reader>> {
        let (_, template) = self.enabled().ok_or_else(|| anyhow::anyhow!("tiles off"))?;
        let url = source_url(template, SystemTime::now());
        let mut slot = self.reader.lock().await;
        if let Some((open, reader)) = slot.as_ref()
            && *open == url
        {
            return Ok(reader.clone());
        }
        let backend = HttpBackend::try_from(self.http.clone(), url.as_str())?;
        let reader = Arc::new(
            AsyncPmTilesReader::try_from_cached_source(backend, HashMapCache::default()).await?,
        );
        *slot = Some((url, reader.clone()));
        Ok(reader)
    }

    /// Fetches one tile, trying again after a failure (slow or flaky links).
    async fn fetch(
        &self,
        reader: &Reader,
        dir: &Path,
        z: u8,
        x: u32,
        y: u32,
    ) -> anyhow::Result<()> {
        let mut wait = Duration::from_secs(1);
        let mut attempt = 1;
        loop {
            match self.fetch_once(reader, dir, z, x, y).await {
                Err(e) if attempt < 3 => {
                    tracing::debug!(
                        error = format!("{e:#}"),
                        "fetching a map tile failed; retrying"
                    );
                    tokio::time::sleep(wait).await;
                    wait *= 3;
                    attempt += 1;
                }
                result => return result,
            }
        }
    }

    /// Fetches one tile from upstream and stores it (an empty file: no tile there).
    async fn fetch_once(
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
        let Some(file) = Self::tile_file_name(z, x, y) else {
            anyhow::bail!("tile path escapes the cache dir");
        };
        let path = dir.join(&file);
        anyhow::ensure!(
            Self::contained(dir, &path),
            "tile path escapes the cache dir"
        );
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let tmp = path.with_extension("tmp");
        tokio::fs::write(&tmp, &data).await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }

    /// Downloads a whole region, then marks it done.
    async fn download_region(&self, rx: u32, ry: u32) -> anyhow::Result<()> {
        let (dir, _) = self.enabled().ok_or_else(|| anyhow::anyhow!("tiles off"))?;
        let reader = self.reader().await?;
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
        let Some(marker_file) = Self::region_file_name(rx, ry) else {
            anyhow::bail!("tile path escapes the cache dir");
        };
        let marker = dir.join(&marker_file);
        anyhow::ensure!(
            Self::contained(dir, &marker),
            "tile path escapes the cache dir"
        );
        tokio::fs::create_dir_all(marker.parent().expect("has a parent")).await?;
        tokio::fs::write(marker, b"").await?;
        self.touch((rx, ry));
        Ok(())
    }

    fn regions_done(dir: &Path) -> usize {
        std::fs::read_dir(dir.join("regions")).map_or(0, |d| d.count())
    }

    /// Records that this area was used just now.
    fn touch(&self, region: (u32, u32)) {
        self.used
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(region, SystemTime::now());
    }

    /// Deletes the least recently used area (marker plus its tiles) to make
    /// room; false when nothing could be removed. `used` is this process's
    /// record of when it served each area; areas it never served fall back to
    /// the marker file's modification time.
    fn evict_oldest(
        dir: &Path,
        max_regions: usize,
        used: &HashMap<(u32, u32), SystemTime>,
    ) -> bool {
        if Self::regions_done(dir) < max_regions.max(1) {
            return true;
        }
        let Ok(entries) = std::fs::read_dir(dir.join("regions")) else {
            return false;
        };
        let mut oldest: Option<(SystemTime, PathBuf, u32, u32)> = None;
        for entry in entries.flatten() {
            let path = entry.path();
            let Some((x, y)) = Self::marker_region(&path) else {
                continue;
            };
            let when = used.get(&(x, y)).copied().unwrap_or_else(|| {
                entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(UNIX_EPOCH)
            });
            if oldest.as_ref().is_none_or(|(t, _, _, _)| when < *t) {
                oldest = Some((when, path, x, y));
            }
        }
        let Some((_, marker, x, y)) = oldest else {
            return false;
        };
        for zoom in REGION_ZOOM..=MAX_ZOOM {
            let shift = zoom - REGION_ZOOM;
            for dx in 0..(1u32 << shift) {
                for dy in 0..(1u32 << shift) {
                    let _ = std::fs::remove_file(Self::tile_path(
                        dir,
                        zoom,
                        (x << shift) + dx,
                        (y << shift) + dy,
                    ));
                }
            }
        }
        std::fs::remove_file(marker).is_ok()
    }

    /// `regions/3-4.done` → `(3, 4)`; `None` for anything else.
    fn marker_region(path: &Path) -> Option<(u32, u32)> {
        let name = path.file_name()?.to_str()?.strip_suffix(".done")?;
        let (x, y) = name.split_once('-')?;
        Some((x.parse().ok()?, y.parse().ok()?))
    }
}

impl Default for Tiles {
    fn default() -> Self {
        Self {
            config: TilesConfig::default(),
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(60))
                .build()
                .expect("HTTP client"),
            reader: tokio::sync::Mutex::new(None),
            downloading: Mutex::new(HashSet::new()),
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_REGIONS)),
            used: Mutex::new(HashMap::new()),
        }
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
    AuthDevice(device): AuthDevice,
    UrlPath((z, x, y)): UrlPath<(u8, u32, String)>,
) -> Result<Response, ApiError> {
    // Tile reads and area downloads are cheap to ask for and expensive to
    // serve, so both are limited per device.
    if !state
        .send_buckets
        .allow(device, state.limits.tile_reads_per_minute)
    {
        return Err(ApiError::TooManyRequests("reading the map too fast"));
    }
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
    let Some(file) = Tiles::tile_file_name(z, x, y) else {
        return Err(ApiError::BadRequest("bad tile"));
    };
    let path = dir.join(&file);
    if !Tiles::contained(&dir, &path) {
        return Err(ApiError::BadRequest("bad tile"));
    }
    if let Ok(data) = tokio::fs::read(&path).await {
        return Ok(tile_response(data));
    }
    if z < REGION_ZOOM {
        // Coarse tiles: fetched one at a time, straight away.
        let reader = tiles.reader().await.map_err(unavailable)?;
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
    let Some(marker_file) = Tiles::region_file_name(region.0, region.1) else {
        return Err(ApiError::BadRequest("bad tile"));
    };
    let marker = dir.join(&marker_file);
    if !Tiles::contained(&dir, &marker) {
        return Err(ApiError::BadRequest("bad tile"));
    }
    // Use counts as recency, so eviction drops cold areas first.
    if marker.exists() {
        tiles.touch(region);
        // Downloaded, but this tile failed then: fetch it now.
        let reader = tiles.reader().await.map_err(unavailable)?;
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
        // Asking for a new area costs a whole download, so it is counted per
        // device per hour (ADR-0033: the server, not the phone, fetches maps).
        if let Some(db) = &state.db {
            let key = format!("tiles-area:{device}");
            if limits::take(db, &key, 1, state.limits.tile_areas_per_hour, HOUR)
                .await
                .is_err()
            {
                tiles
                    .downloading
                    .lock()
                    .expect("not poisoned")
                    .remove(&region);
                return Err(ApiError::TooManyRequests(
                    "too many new map areas; try again later",
                ));
            }
        }
        if Tiles::regions_done(&dir) >= tiles.config.max_regions {
            // Make room instead of refusing forever: drop the least recently
            // used area. File work happens off the async runtime.
            let (evict_dir, max) = (dir.clone(), tiles.config.max_regions);
            let used = tiles.used.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let freed =
                tokio::task::spawn_blocking(move || Tiles::evict_oldest(&evict_dir, max, &used))
                    .await
                    .unwrap_or(false);
            if !freed {
                tiles
                    .downloading
                    .lock()
                    .expect("not poisoned")
                    .remove(&region);
                return Err(ApiError::TooManyRequests(
                    "this server keeps no more map areas",
                ));
            }
        }
        tokio::spawn(async move {
            // Bounds how many areas download at once; waits, then starts.
            let _slot = tiles.slots.acquire().await;
            if let Err(e) = tiles.download_region(region.0, region.1).await {
                // The whole chain (DNS, TLS, timeout…): the top line alone says little.
                tracing::warn!(error = format!("{e:#}"), "downloading a map area failed");
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
    tracing::warn!(error = format!("{e:#}"), "map tiles unavailable");
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

    #[test]
    fn eviction_finds_and_drops_the_oldest_area() {
        let dir = std::env::temp_dir().join(format!("tiles-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("regions")).unwrap();
        for (i, (x, y)) in [(1u32, 1u32), (2, 2)].into_iter().enumerate() {
            let marker = dir.join(Tiles::region_file_name(x, y).unwrap());
            std::fs::write(&marker, b"").unwrap();
            let tile = Tiles::tile_path(&dir, 11, x * 2, y * 2);
            std::fs::create_dir_all(tile.parent().unwrap()).unwrap();
            std::fs::write(&tile, b"t").unwrap();
            let when = UNIX_EPOCH + Duration::from_secs(1_000 + i as u64 * 1_000);
            std::fs::File::options()
                .write(true)
                .open(&marker)
                .unwrap()
                .set_modified(when)
                .unwrap();
        }
        assert_eq!(
            Tiles::marker_region(Path::new("regions/3-4.done")),
            Some((3, 4))
        );
        assert_eq!(Tiles::marker_region(Path::new("regions/x.done")), None);
        assert!(Tiles::evict_oldest(
            &dir,
            2,
            &std::collections::HashMap::new()
        ));
        assert!(!dir.join("regions/1-1.done").exists());
        assert!(dir.join("regions/2-2.done").exists());
        assert!(!Tiles::tile_path(&dir, 11, 2, 2).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
