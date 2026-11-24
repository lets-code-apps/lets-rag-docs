//! `lets-rag-docs status --json`: the two facts the desktop overview needs that no other
//! report carries - is the model answering, and when was the library last synced.
//!
//! Read-only and hostile-data-safe like `documents --json`: a model that refuses the local
//! network rule or is simply down is reported as data (`reachable: false`, exit 0), never
//! as an error; only config/IO failures exit non-zero. The command reads nothing about
//! documents: `last_sync` is the database file's mtime, and the probe is one local GET.

use serde::Serialize;

use crate::ask::check_base_url;
use crate::config::{Config, LlmConfig};

#[derive(Serialize)]
struct Report {
    /// Wire format version: a consumer that speaks 1 refuses anything else.
    version: u8,
    model: Model,
    /// mtime of `[paths] db` as an RFC 3339 UTC timestamp; null when there is no database
    /// file yet (the library was never built - not an error; the overview says "never").
    last_sync: Option<String>,
}

#[derive(Serialize)]
struct Model {
    /// Whether the configured model answers right now. `false` is data: the overview
    /// shows "model unreachable" and the rest of the app keeps working.
    reachable: bool,
}

pub async fn run(config: &Config, json: bool) -> anyhow::Result<()> {
    if !json {
        return Err(anyhow::anyhow!(
            "status: pass --json (this command reports the model and last sync for machines only)"
        ));
    }
    let report = collect(config).await?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

/// A probe timeout of its own: the question is "is something answering in a few seconds",
/// so it must not inherit `llm.timeout_seconds` (minutes, meant for generation).
const PROBE_TIMEOUT_SECONDS: u64 = 3;

/// The two facts. `Report` is built from values, never from the clock or the network,
/// so the shape-lock test fixes both directly (the seam).
async fn collect(config: &Config) -> anyhow::Result<Report> {
    Ok(Report {
        version: 1,
        model: Model {
            reachable: reachable(&config.llm).await,
        },
        last_sync: last_sync(config),
    })
}

/// Ask the OpenAI-compatible endpoint what it has: `GET {base_url}/models` is the cheapest
/// local proof of life (Ollama serves it). The same local-network rule as `ask` runs
/// before any request goes out; a timeout, a non-2xx answer or a dead port is `false`,
/// not an error, and nothing here ever `unwrap`s a request.
async fn reachable(llm: &LlmConfig) -> bool {
    if check_base_url(llm).is_err() {
        return false;
    }
    let url: String = format!("{}/models", llm.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(PROBE_TIMEOUT_SECONDS))
        .build();
    // A client that cannot be built at all is simply not reachable.
    match client {
        Err(_) => false,
        Ok(client) => match client.get(&url).send().await {
            Err(_) => false,
            Ok(response) => response.status().is_success(),
        },
    }
}

/// The library's own clock: mtime of the database file, no query run against it. A pre-1970
/// mtime (a negative count of seconds in the Unix metadata) is unknown like a missing
/// file, not a crash.
fn last_sync(config: &Config) -> Option<String> {
    let mtime = match std::fs::symlink_metadata(&config.paths.db) {
        Err(_) => return None,
        Ok(meta) => file_mtime(meta),
    };
    if mtime < 0 {
        return None;
    }
    Some(rfc3339_utc(mtime as u64))
}

/// `st_mtime` comes from `std::os::macos::fs::MetadataExt`, one body per OS (same
/// `#[cfg]` pattern `documents.rs` uses for `st_flags`): off macOS there is no
/// portable seconds-resolution mtime in the standard library, so `null` — unknown —
/// rather than a guess.
#[cfg(target_os = "macos")]
fn file_mtime(meta: std::fs::Metadata) -> i64 {
    use std::os::macos::fs::MetadataExt;
    meta.st_mtime()
}

#[cfg(not(target_os = "macos"))]
fn file_mtime(_meta: std::fs::Metadata) -> i64 {
    -1
}

/// Whole days since 1970-01-01 to a calendar date: walk whole years, then whole months.
/// ~100 iterations for a modern timestamp, and it reads far better than the bit-trick
/// calendars it replaces - which is the point, since the output is a timestamp for people.
fn civil_from_days(days: i64) -> (i64, u8, u8) {
    let leap = |year: i64| year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let mut year = 1970;
    let mut rest = days;
    // Years before 1970 are filtered out upstream (`duration_since` fails first), so the
    // walk only moves forward.
    loop {
        let length = if leap(year) { 366 } else { 365 };
        if rest < length {
            break;
        }
        rest -= length;
        year += 1;
    }
    let months: [i64; 12] = if leap(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month: usize = 0;
    while rest >= months[month] {
        rest -= months[month];
        month += 1;
    }
    (year, (month + 1) as u8, (rest + 1) as u8)
}

/// A UTC RFC 3339 timestamp from whole seconds since the Unix epoch, with no date crate:
/// the std clock gives seconds, this gives the eleven numbers of `YYYY-MM-DDThh:mm:ssZ`.
fn rfc3339_utc(secs: u64) -> String {
    let days: i64 = (secs / 86_400) as i64;
    let in_day = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month,
        day,
        in_day / 3_600,
        in_day / 60 % 60,
        in_day % 60,
    )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::config::Config;

    fn llm(base_url: &str) -> LlmConfig {
        LlmConfig {
            base_url: base_url.to_string(),
            ..LlmConfig::default()
        }
    }

    // Fixture lock shared with the TS tests and the fake engine: `testdata/desktop/<name>.json`
    // holds the exact bytes; LOCK_FIXTURES=1 rewrites them.
    fn lock(name: &str, actual: &str) {
        let fixture: PathBuf = PathBuf::from("testdata/desktop").join(name);
        if std::env::var("LOCK_FIXTURES")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            std::fs::create_dir_all(fixture.parent().unwrap()).unwrap();
            std::fs::write(&fixture, actual).unwrap();
            return;
        }
        let want: String = std::fs::read_to_string(&fixture)
            .expect("fixture missing: run the tests once with LOCK_FIXTURES=1");
        assert_eq!(
            actual,
            want.as_str(),
            "JSON shape changed (or the fixture is stale)"
        );
    }

    #[tokio::test]
    async fn reachable_on_2xx() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"name": "qwen3:30b-a3b"}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        assert!(reachable(&llm(&format!("{}/v1", server.uri()))).await);
    }

    #[tokio::test]
    async fn unreachable_on_500_or_dead_port() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        assert!(!reachable(&llm(&format!("{}/v1", server.uri()))).await);

        // Nothing is listening on this port: the 3 s budget must answer, not hang. A
        // connection refused returns long before it, but the bound proves the timeout
        // is finite either way.
        let started = std::time::Instant::now();
        assert!(!reachable(&llm("http://127.0.0.1:1/v1")).await);
        assert!(
            std::time::Instant::now() - started < std::time::Duration::from_secs(10),
            "the probe is bounded by its own timeout"
        );
    }

    #[tokio::test]
    async fn refused_base_url_is_unreachable() {
        // The privacy rule refuses a public host outright; that reads as "not reachable"
        // on this machine, not as an error.
        assert!(!reachable(&llm("http://8.8.8.8/v1")).await);
    }

    #[test]
    fn last_sync_is_db_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.db = dir.path().join("data/documents.sqlite");
        assert_eq!(
            last_sync(&config),
            None,
            "no database file yet: unknown, not an error"
        );
        fs_touch(&config.paths.db);
        let meta = std::fs::symlink_metadata(&config.paths.db).unwrap();
        assert_eq!(
            last_sync(&config),
            Some(rfc3339_utc(file_mtime(meta) as u64)),
            "the mtime, formatted"
        );
    }

    fn fs_touch(path: &PathBuf) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[test]
    fn rfc3339_utc_known_values() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        // A leap day: 2024-02-29.
        assert_eq!(rfc3339_utc(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn status_json_shape_is_locked() {
        // The seam: build the Report from fixed values, never the clock or the network.
        let report = Report {
            version: 1,
            model: Model { reachable: true },
            last_sync: Some("2024-02-29T00:00:00Z".to_string()),
        };
        let json: String = serde_json::to_string(&report).unwrap();
        lock("status.json", &json);
    }
}
