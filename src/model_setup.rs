//! `model detect | pull | save`: the first-run setup commands (LET-136, ported from
//! lets-triage-mail PR #26 so both apps speak the same JSON and share the same `model.toml`).
//!
//! The desktop onboarding asks what model servers are running, downloads a model, and
//! records the choice in the shared `model.toml` (see `guide/MODEL.md`). These are the three
//! engine commands it calls; the desktop itself never makes a network call (see
//! `desktop/README.md`).
//!
//! Privacy rule: a model endpoint must be on the local network - the same rule as `[llm]
//! base_url` (see `is_local_or_private_host` in `ask.rs`). `detect --url` and `pull --url`
//! refuse anything else, and `save` refuses to record a remote url, so document text can
//! never end up at a model server outside the user's own network. This crate's `reqwest`
//! is built without any TLS feature, so the rule is strict `http://`: an `https://`
//! endpoint cannot be reached at all and is refused like a non-local one.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::ask::is_local_or_private_host;
use crate::config::{Config, Written};
use crate::shared_model;
use crate::status::rfc3339_utc;
use anyhow::anyhow;

/// Where Ollama listens by default.
pub const OLLAMA_URL: &str = "http://127.0.0.1:11434";

/// Where LM Studio listens by default.
pub const LM_STUDIO_URL: &str = "http://127.0.0.1:1234";

/// The time limit for one `GET {url}/v1/models` probe. Both default probes run at the
/// same time, so a dead port costs the desktop 2 s, not 4 s.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// A model server to probe: the runtime name (as in `shared_model::RUNTIMES`) and its
/// base url, for example `ollama` at `http://127.0.0.1:11434`.
pub struct Endpoint {
    pub runtime: String,
    pub url: String,
}

/// The default probes: both servers a Mac user is likely to have running, checked at
/// once.
pub fn default_endpoints() -> Vec<Endpoint> {
    vec![
        Endpoint {
            runtime: "ollama".to_string(),
            url: OLLAMA_URL.to_string(),
        },
        Endpoint {
            runtime: "lmstudio".to_string(),
            url: LM_STUDIO_URL.to_string(),
        },
    ]
}

/// What one probe learned about one endpoint.
pub struct Found {
    pub runtime: String,
    pub url: String,
    pub reachable: bool,
    /// Installed model ids, as the server lists them.
    pub models: Vec<String>,
    /// The ids usable for documents: ids that do not contain `embed` (embedding
    /// models answer only similarity queries, never chat). The desktop needs both
    /// lists to tell "found, nothing usable" (only an embedding model installed)
    /// apart from "nothing installed".
    pub usable: Vec<String>,
    /// Why it is not reachable, when it is not.
    pub error: Option<String>,
}

/// The shared `model.toml` as `detect` reports it: only present when the file is
/// complete (url and model both set). `reachable` says whether that url answers now,
/// so the desktop can tell "the other app chose this and it works" from "the other
/// app chose it but its server is off".
pub struct SharedBlock {
    pub runtime: String,
    pub url: String,
    pub model: String,
    pub set_by: String,
    pub reachable: bool,
}

/// The result of `detect`: one entry per probe, in the order given, plus the shared
/// block when it exists. `detect` never fails: a server that is off the network is
/// simply `reachable = false` with its error text.
pub struct Detection {
    pub runtimes: Vec<Found>,
    pub shared: Option<SharedBlock>,
}

/// Probes every endpoint (`tokio::join!` for the two defaults) and reports the shared
/// file the caller passed in - never `$HOME` (paths come from the caller, so tests
/// decide the path).
pub async fn detect(endpoints: Vec<Endpoint>, shared: shared_model::SharedModel) -> Detection {
    let client = probe_client();

    let runtimes: Vec<Found> = match endpoints.len() {
        // One endpoint (a `--url` replacement): probe it alone.
        1 => vec![probe_endpoint(&client, &endpoints[0]).await],
        // Two defaults: start both probes, then wait for both with `tokio::join!`,
        // so the wall-clock cost is one timeout even if both ports are dead.
        2 => {
            let first = probe_endpoint(&client, &endpoints[0]);
            let second = probe_endpoint(&client, &endpoints[1]);
            let (older, newer) = tokio::join!(first, second);
            vec![older, newer]
        }
        // Not the production shape, but correct: probe them one after another.
        _ => {
            let mut items: Vec<Found> = Vec::new();
            for endpoint in endpoints.iter() {
                items.push(probe_endpoint(&client, endpoint).await);
            }
            items
        }
    };

    // The shared block: probe the stored base url, but only under the same local-only rule the
    // `--url` path uses (review finding 2, LET-165). `shared_model::read` does not vet the url, so
    // a shared `model.toml` that names a public host must NEVER make this app send a request there.
    // `ensure_local` runs before `probe_listing`: a refused endpoint reports `reachable = false` and
    // dispatches nothing.
    let shared_block: Option<SharedBlock> = match shared.chat_base_url() {
        None => None,
        Some(base_url) => {
            let reachable = match ensure_local(base_url.to_string()) {
                Err(_) => false,
                Ok(local_url) => probe_listing(&client, local_url).await.is_ok(),
            };
            Some(SharedBlock {
                runtime: shared.runtime.clone().unwrap_or_default(),
                url: shared.url.clone().unwrap_or_default(),
                // `chat_model` borrows from `shared`; this field owns a copy.
                model: shared.chat_model().unwrap_or("").to_string(),
                set_by: shared.set_by.clone().unwrap_or_default(),
                reachable,
            })
        }
    };
    Detection {
        runtimes,
        shared: shared_block,
    }
}

/// The HTTP client for the probes: no redirects (a redirect would follow the server's
/// `Location:` to a host outside the local-network rule) and a short total timeout -
/// one dead port costs the desktop 2 s.
pub fn probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("a basic HTTP client always builds")
}

/// The HTTP client for `model pull`: same no-redirect rule, but **no total timeout**.
///
/// A model download is a single response whose body streams for minutes (a multi-GB
/// blob). The probe's 2 s total timeout would cut that stream after two seconds, so a
/// download must use a client without it. A short `connect_timeout` is kept so a
/// dead port still fails fast.
pub fn download_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("a basic HTTP client always builds")
}

/// One endpoint: `GET {url}/v1/models`. Both Ollama and LM Studio answer that OpenAI-style
/// path; any HTTP answer proves reachability, but only a parseable list gives model ids.
async fn probe_endpoint(client: &reqwest::Client, endpoint: &Endpoint) -> Found {
    match probe_listing(client, endpoint.url.clone()).await {
        Err(error) => Found {
            runtime: endpoint.runtime.clone(),
            url: endpoint.url.clone(),
            reachable: false,
            models: Vec::new(),
            usable: Vec::new(),
            error: Some(error),
        },
        Ok((status, body)) => {
            let (models, usable) = parse_model_list(status, body);
            Found {
                runtime: endpoint.runtime.clone(),
                url: endpoint.url.clone(),
                reachable: true,
                models,
                usable,
                error: None,
            }
        }
    }
}

/// `GET {url}/v1/models` under the timeout: the status and body, or the error text.
async fn probe_listing(client: &reqwest::Client, url: String) -> Result<(u16, String), String> {
    let response = match client.get(models_url(url.as_str())).send().await {
        Err(error) => return Err(describe_error(error)),
        Ok(response) => response,
    };
    let status = response.status().as_u16();
    // A body that cannot be read counts as empty; the status is what proves
    // reachability.
    let body = response.text().await.unwrap_or(String::new());
    Ok((status, body))
}

/// `{url}/v1/models`, unless the url already names `/v1` (see `chat_base_url` in
/// `shared_model.rs`).
fn models_url(url: &str) -> String {
    let base = url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

/// The shape of an OpenAI `GET /models` answer; only the ids matter.
#[derive(Deserialize)]
struct Listing {
    data: Vec<Listed>,
}

#[derive(Deserialize)]
struct Listed {
    id: String,
}

/// Ids from a 2xx listing; a body that does not parse is "reachable, no list" (some
/// servers cannot list models, and chat may still work).
fn parse_model_list(status: u16, body: String) -> (Vec<String>, Vec<String>) {
    let ids: Vec<String> = match status {
        200..=299 => match serde_json::from_str::<Listing>(body.as_str()) {
            Err(_) => Vec::new(),
            Ok(list) => list
                .data
                .into_iter()
                .map(|entry| entry.id.to_string())
                .collect(),
        },
        _ => Vec::new(),
    };
    // Embedding models are listed but cannot answer chat; the desktop needs both lists
    // to tell "found, nothing usable" from "nothing installed".
    let usable = ids
        .clone()
        .into_iter()
        .filter(|id| !id.contains("embed"))
        .collect();
    (ids, usable)
}

/// reqwest's `Display` for a refused connection is just "error sending request"; the
/// useful cause sits at the end of the `source` chain.
fn describe_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "timed out".to_string();
    }
    let mut root: &dyn std::error::Error = &error;
    while let Some(cause) = root.source() {
        root = cause;
    }
    root.to_string()
}

// ------------------------------------------------------------------- pull

/// `model pull`: asks Ollama to download a model. Ollama's native endpoint is
/// `POST {url}/api/pull` with body `{"model": name}`; its answer is NDJSON - one JSON
/// object per line (`pulling manifest`, `downloading`, `verifying`, `writing manifest`,
/// `success`, or `error`). A non-2xx request (LM Studio answers 404: it downloads
/// through its own GUI, not this endpoint) returns one sentence, which the CLI prints
/// as an error line and exits 1 on.
///
/// Errors inside the stream are *lines*, not thrown: the stream ends with
/// `{"stage": "error", ...}` and the CLI exits 1 (the desktop reads lines until the
/// stream ends, then shows the failure).
pub async fn start_pull(
    client: reqwest::Client,
    url: String,
    model: String,
) -> Result<reqwest::Response, String> {
    let body = json!({"model": model}).to_string();
    let request = client
        .post(format!("{}/api/pull", url.trim_end_matches('/')))
        .body(body);
    let response = match request.send().await {
        Err(error) => return Err(describe_error(error)),
        Ok(response) => response,
    };
    if response.status().is_success() {
        return Ok(response);
    }
    // The server's own sentence if it gave one (Ollama's 404 names the model), else the
    // status number. `text` consumes the response body, so read the status first.
    let code = response.status().as_u16();
    let text = response.text().await.unwrap_or(String::new());
    let why = text.trim().to_string();
    if !why.is_empty() {
        return Err(why);
    }
    Err(format!("the model server answered HTTP {code}"))
}

/// Splits `buffer` on `\n`, returning the complete lines and the unfinished tail. A
/// chunk of the raw byte stream never lines up with a line: one line can span two
/// chunks and one chunk can hold several lines, so the caller feeds the returned tail
/// back in with the next chunk. Taking and returning the buffer by value keeps that
/// ownership hand-off explicit. The split is at an ASCII `\n`, so cutting UTF-8 text
/// on it is safe.
pub fn drain_lines(buffer: Vec<u8>) -> (Vec<String>, Vec<u8>) {
    let mut complete: Vec<String> = Vec::new();
    // `start` is the first byte of the line being scanned; it advances past each `\n`.
    let mut start: usize = 0;
    for (index, byte) in buffer.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        // `start..index` is one whole line (the `\n` at `index` is the delimiter, not
        // part of the line). Invalid UTF-8 from a hostile server decodes with
        // replacement characters, never a panic.
        complete.push(String::from_utf8_lossy(&buffer[start..index]).to_string());
        start = index + 1;
    }
    // Everything after the last newline is the tail for the next chunk.
    let tail = buffer[start..].to_vec();
    (complete, tail)
}

/// One NDJSON line in, one line out in the shape the desktop reads:
/// `{"stage": "pulling manifest"}`, `{"stage": "downloading", "total": N, "completed":
/// M}` when the server reports progress numbers, `{"stage": "success"}`,
/// `{"stage": "error", "error": "..."}`. A line that is not JSON becomes
/// `{"stage": "other", "status": "<raw text>"}` so nothing is silently dropped.
pub fn normalise_pull_line(raw: String) -> Value {
    let parsed = match serde_json::from_str::<Value>(raw.as_str()) {
        Err(_) => return json!({"stage": "other", "status": raw}),
        Ok(value) => value,
    };
    // An error line wins: it carries the reason the pull stopped.
    if let Some(value) = parsed.get("error")
        && let Some(error) = value.as_str()
    {
        return json!({"stage": "error", "error": error});
    }
    let status = match parsed.get("status") {
        Some(value) => value.as_str().unwrap_or(raw.as_str()),
        None => raw.as_str(),
    };
    // Ollama's download lines read "downloading <hash>: 43%"; one stage name for all
    // of them keeps the desktop's progress bar simple.
    let stage = if status.starts_with("downloading") {
        "downloading".to_string()
    } else {
        status.to_string()
    };
    let mut line = json!({"stage": stage});
    // Progress numbers, when the server sends them: `total` and `completed` bytes.
    if let Some(value) = parsed.get("total")
        && value.is_number()
    {
        line["total"] = value.clone();
    }
    if let Some(value) = parsed.get("completed")
        && value.is_number()
    {
        line["completed"] = value.clone();
    }
    line
}

/// The outcome of reading a whole pull stream: the normalised lines the desktop shows,
/// plus three flags the CLI needs to decide whether the download actually finished.
///
/// A stream can end without ever reaching the `success` stage (the server closed the
/// body early, or a timeout cut it), and reading the body can itself fail mid-download.
/// Treating either as success would leave the desktop believing a partial download is a
/// finished model, so the caller checks these flags rather than trusting "the loop
/// ended".
pub struct PullStream {
    /// The collected normalised lines, kept so the library tests can assert on a whole stream
    /// without a real server. The CLI's `pull` streams via `emit` and decides the exit code from
    /// the three flags below, so it never reads this field.
    #[allow(dead_code)] // read by the library tests (consume_pull_stream)
    pub lines: Vec<Value>,
    /// A `{"stage": "success"}` line arrived: the download is complete.
    pub saw_success: bool,
    /// A `{"stage": "error", ...}` line arrived: the server reported why it stopped.
    pub saw_error: bool,
    /// Reading the body failed (a dropped connection or a client timeout cut it
    /// mid-stream).
    pub read_failed: bool,
}

/// Reads a pull response's NDJSON body to the end, chunk by chunk, into [`PullStream`],
/// and hands every normalised line to `emit` the moment it arrives.
///
/// The `emit` callback is what makes progress live: the CLI's stdout writer runs per
/// line, while the download runs, so a multi-minute model shows progress the instant the
/// server writes it instead of after the body ends.
pub async fn consume_pull_stream_to<Emit: FnMut(Value)>(
    mut response: reqwest::Response,
    mut emit: Emit,
) -> PullStream {
    let mut lines: Vec<Value> = Vec::new();
    let mut saw_success: bool = false;
    let mut saw_error: bool = false;
    let mut read_failed: bool = false;
    let mut buffer: Vec<u8> = Vec::new();

    loop {
        match response.chunk().await {
            Err(_) => {
                read_failed = true;
                break;
            }
            Ok(None) => break,
            Ok(Some(chunk)) => {
                buffer.extend(chunk);
                let (complete, tail) = drain_lines(buffer);
                buffer = tail;
                for line in complete.iter() {
                    let shaped = normalise_pull_line(line.to_string());
                    match shaped
                        .get("stage")
                        .and_then(|stage| stage.as_str())
                        .unwrap_or("")
                    {
                        "success" => saw_success = true,
                        "error" => saw_error = true,
                        _ => {}
                    }
                    lines.push(shaped.clone());
                    emit(shaped.clone());
                }
            }
        }
    }

    // Anything after the last newline is a final, unterminated line.
    if !buffer.is_empty() {
        let shaped = normalise_pull_line(String::from_utf8_lossy(&buffer).to_string());
        match shaped
            .get("stage")
            .and_then(|stage| stage.as_str())
            .unwrap_or("")
        {
            "success" => saw_success = true,
            "error" => saw_error = true,
            _ => {}
        }
        lines.push(shaped.clone());
        emit(shaped.clone());
    }

    PullStream {
        lines,
        saw_success,
        saw_error,
        read_failed,
    }
}

/// The flags-only form used by the library tests: read the whole stream and collect the
/// lines, handing nothing over as it arrives (the emit callback does nothing).
#[allow(dead_code)] // convenience wrapper exercised only by the unit tests
pub async fn consume_pull_stream(response: reqwest::Response) -> PullStream {
    consume_pull_stream_to(response, |_line: Value| {}).await
}

/// Whether a finished pull stream must be treated as a failure (the CLI uses this to
/// exit 1). Three independent ways a pull has NOT finished: the body read failed, the
/// server reported an error stage, or the stream ended without ever reaching the
/// `success` stage. A loop merely ending is not proof of success.
pub fn pull_stream_failed(stream: PullStream) -> bool {
    stream.read_failed || stream.saw_error || !stream.saw_success
}

// ------------------------------------------------------------------- local rule & save

/// The host part of an `http://host[:port]/path` url, for the local-only rule.
///
/// Uses `reqwest::Url` (as `ask::check_base_url` does): `host_str()` returns the hostname
/// *without* the port, which is the text `is_local_or_private_host` understands (it
/// parses `127.0.0.1` as an `IpAddr`; `127.0.0.1:11434` would not parse).
pub fn host_of(url: &str) -> Option<String> {
    let parsed = match reqwest::Url::parse(url.trim()) {
        Err(_) => return None,
        Ok(parsed) => parsed,
    };
    // Only a page url counts, and only plain `http`: this crate has no TLS feature
    // at all, so an `https://` endpoint cannot be reached and is refused like any
    // unusable url.
    if parsed.scheme() != "http" {
        return None;
    }
    // `host_str()` borrows from `parsed`; `map` copies the host into an owned String.
    parsed.host_str().map(|host| host.to_string())
}

/// Refuses a model url that is not on the local network, with a message naming the
/// url. Used by `model detect --url`, `model pull --url` and `model save --url`.
pub fn ensure_local(url: String) -> Result<String, String> {
    match host_of(url.as_str()) {
        None => Err(format!("`{url}` is not an http:// url")),
        Some(host) if is_local_or_private_host(host.as_str()) => Ok(url),
        Some(_host) => Err(format!(
            "`{url}` is not on the local network; model servers must be local so documents never leave your network"
        )),
    }
}

/// The current wall-clock time in whole seconds since the Unix epoch. This toolchain's
/// standard library exposes no wall-clock call, so the clock comes from the bundled
/// SQLite (`rusqlite`, already a dependency): `SELECT unixepoch()` answers with the
/// same UTC seconds the `status` command formats.
pub fn now_seconds() -> u64 {
    // `open_in_memory()` returns a `Result` and rusqlite 0.41 has no `query_scalar`,
    // so read the one value with `query_row` (the same shape `db.rs` uses). Any failure
    // here falls back to 0 rather than panicking: a missing timestamp is a cosmetic
    // detail of the shared file, never a reason to abort a save.
    let conn: rusqlite::Connection = match rusqlite::Connection::open_in_memory() {
        Err(_) => return 0,
        Ok(conn) => conn,
    };
    let seconds: i64 = match conn.query_row("SELECT unixepoch()", [], |row| row.get(0)) {
        Err(_) => return 0,
        Ok(value) => value,
    };
    if seconds < 0 {
        return 0;
    }
    seconds as u64
}

/// `model save`: records the choice in the shared `model.toml` through
/// [`shared_model::write`], which validates first (an unknown runtime, a blank model
/// or credentials in the url are refused before anything is written). The url goes
/// through [`ensure_local`] first: the privacy rule is enforced here, not by the
/// shared file's own rules (the other app has its own).
pub fn save_to_shared(
    path: &Path,
    runtime: String,
    url: String,
    model: String,
) -> Result<(), String> {
    let local_url = ensure_local(url)?;
    let record = shared_model::SharedModel {
        runtime: Some(runtime),
        url: Some(local_url),
        model: Some(model),
        // Which app wrote the file last (see `shared_model::WRITERS`); `detect`
        // reports it so the desktop can say "the model is shared with RAG Docs".
        set_by: Some("rag docs".to_string()),
        updated: Some(rfc3339_utc(now_seconds())),
    };
    match shared_model::write(path, &record) {
        Err(error) => Err(error.to_string()),
        Ok(_value) => Ok(()),
    }
}

// ------------------------------------------------------------------- CLI handlers

/// `model detect --json`: probe the endpoints and report what answers, plus the shared
/// file and this app's own effective model (`config`). A refusal (a non-local `--url`)
/// is `{ok:false,error}` with exit 1.
pub async fn detect_cmd(
    config: &Config,
    path: &Path,
    shared: &Path,
    url: Option<String>,
    json: bool,
) -> anyhow::Result<()> {
    let endpoints: Vec<Endpoint> = match url {
        None => default_endpoints(),
        Some(addr) => {
            let local = match ensure_local(addr.clone()) {
                Err(reason) => {
                    if json {
                        println!("{}", failure_json(anyhow!(reason)));
                        std::process::exit(1);
                    }
                    return Err(anyhow!(reason));
                }
                Ok(value) => value,
            };
            vec![Endpoint {
                runtime: "custom".to_string(),
                url: local,
            }]
        }
    };
    let shared_file: shared_model::SharedModel = shared_model::read(shared);
    let detection = detect(endpoints, shared_file).await;
    if json {
        println!(
            "{}",
            serde_json::to_string(&detect_json(&detection, config, path))?
        );
    } else {
        println!("{}", detect_text(&detection));
    }
    Ok(())
}

/// The `config` key of `model detect --json`: the model this app would use today, and
/// whether the user pinned one in `config.toml` (`overridden`). The desktop
/// preselects `model` only when the user did not pin a different `[llm]` setting,
/// so a saved shared choice never contradicts an explicit choice in this app.
fn config_json(config: &Config, path: &Path) -> Value {
    json!({"model": config.llm.model, "overridden": llm_keys_written(path)})
}

/// Whether `[llm] base_url` or `model` are written in the user's own `config.toml`
/// (the same "written" probe `Config::apply_shared` uses, via `config::Written`). A
/// file that cannot be read counts as unwritten: `detect` is read-only data, and
/// the caller has already loaded (or defaulted) the config.
fn llm_keys_written(path: &Path) -> bool {
    let text: String = match std::fs::read_to_string(path.as_os_str()) {
        Ok(text) => text,
        Err(_) => return false,
    };
    let written: Written = toml::from_str(text.as_str()).unwrap_or(Written::default());
    written.llm.base_url.is_some() || written.llm.model.is_some()
}

/// A short human-readable report for `model detect` without `--json`.
fn detect_text(detection: &Detection) -> String {
    let mut lines: Vec<String> = Vec::new();
    for found in detection.runtimes.iter() {
        if found.reachable {
            let usable = if found.usable.is_empty() {
                "no usable model installed".to_string()
            } else {
                format!("usable: {}", found.usable.join(", "))
            };
            lines.push(format!(
                "{runtime} at {url} reachable, {usable}",
                runtime = found.runtime,
                url = found.url,
                usable = usable
            ));
        } else {
            let why = found.error.clone().unwrap_or("unreachable".to_string());
            lines.push(format!(
                "{runtime} at {url} not reachable ({why})",
                runtime = found.runtime,
                url = found.url,
                why = why
            ));
        }
    }
    if let Some(block) = detection.shared.as_ref() {
        let state = if block.reachable {
            "answers"
        } else {
            "server off now"
        };
        lines.push(format!(
            "shared model from {set_by}: {model} at {url} ({state})",
            set_by = block.set_by,
            model = block.model,
            url = block.url,
            state = state,
        ));
    }
    lines.join("\n")
}

/// The shape of `model detect --json`, locked by a test because the desktop parses it.
fn detect_json(detection: &Detection, config: &Config, path: &Path) -> Value {
    let runtimes: Vec<Value> = detection
        .runtimes
        .iter()
        .map(|found| {
            json!({
                "runtime": found.runtime,
                "url": found.url,
                "reachable": found.reachable,
                "models": found.models,
                "usable": found.usable,
                "error": found.error,
            })
        })
        .collect();
    let shared: Value = match detection.shared.as_ref() {
        None => json!(null),
        Some(block) => json!({
            "runtime": block.runtime,
            "url": block.url,
            "model": block.model,
            "set_by": block.set_by,
            "reachable": block.reachable,
        }),
    };
    json!({
        "ok": true,
        "runtimes": runtimes,
        "shared": shared,
        "config": config_json(config, path),
    })
}

/// The success shape of `model save --json`.
fn save_json(runtime: &String, url: &String, model: &String) -> Value {
    json!({"ok": true, "runtime": runtime, "url": url, "model": model})
}

/// `model save --json`: write the choice to the shared file. The local-only rule and
/// the shared-file validation (unknown runtime, blank model, credentials in the url)
/// all run before anything is written, so a refusal leaves the file untouched:
/// `{ok:false,error}` exit 1.
pub fn save_cmd(
    shared: &Path,
    runtime: String,
    url: String,
    model: String,
    json: bool,
) -> anyhow::Result<()> {
    // Build the report and the text first (they only borrow), then hand the owned
    // strings to the write.
    let record: Value = save_json(&runtime, &url, &model);
    let text: String = format!("saved {} ({}) at {}", model, runtime, url);
    // A refusal (the local rule or the shared-file validation) leaves the file untouched.
    if let Err(reason) = save_to_shared(shared, runtime, url, model) {
        if json {
            println!("{}", failure_json(anyhow!(reason)));
            std::process::exit(1);
        }
        return Err(anyhow!(reason));
    }
    if json {
        println!("{}", serde_json::to_string(&record)?);
    } else {
        println!("{}", text);
    }
    Ok(())
}

/// `model pull --json [--url=<addr>] -- <model>`: Ollama's `POST /api/pull` answer is
/// NDJSON, streamed through the same line buffer the library tests cover. Each line
/// becomes one JSON object on stdout (`{"stage": ...}`); an error line is still just
/// a line, and the command exits 1 once the stream ends if one was seen. A server
/// that refuses the request outright (a 404 from LM Studio) is a one-sentence failure,
/// printed as the usual failure object.
pub async fn pull(url: Option<String>, model: String, _json: bool) -> anyhow::Result<()> {
    let base: String = match url {
        None => OLLAMA_URL.to_string(),
        Some(addr) => match ensure_local(addr.clone()) {
            Err(reason) => {
                println!("{}", json!({"ok": false, "error": reason}));
                std::process::exit(1);
            }
            Ok(value) => value,
        },
    };
    // A download uses `download_client` (no total timeout), not the 2 s probe client:
    // a real model pull streams its body for far longer than two seconds.
    let client = download_client();
    let response = match start_pull(client, base, model).await {
        Err(reason) => {
            println!("{}", json!({"ok": false, "error": reason}));
            std::process::exit(1);
        }
        Ok(body) => body,
    };

    // Read the NDJSON body as it arrives: every normalised line is written AND flushed
    // the moment the stream delivers it (a multi-minute download must show live
    // progress, not sit at zero until the server closes), while the three flags decide
    // the exit code (a `success` stage, an `error` stage, or a body that failed to read
    // or stopped before finishing).
    let stream = consume_pull_stream_to(response, |line: Value| {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{}", line);
        let _ = out.flush();
    })
    .await;

    // If the stream never reached `success` and never printed its own error line, add
    // one so the desktop sees why: a dropped connection (`read_failed`) or a body
    // that stopped early.
    if !stream.saw_success && !stream.saw_error {
        let reason = if stream.read_failed {
            "the model server closed the download before it finished"
        } else {
            "the download ended before the model finished"
        };
        println!("{}", json!({"stage": "error", "error": reason}));
    }

    // Non-zero unless the server confirmed `success`.
    if pull_stream_failed(stream) {
        std::process::exit(1);
    }
    Ok(())
}

/// The failure shape the app reads when a command could not run.
fn failure_json(error: anyhow::Error) -> Value {
    json!({"ok": false, "error": format!("{error:#}")})
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;

    // Fixture lock shared with the TS tests and the fake engine: `testdata/desktop/<name>.json`
    // holds the exact bytes the app emits; LOCK_FIXTURES=1 rewrites them.
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

    // --- url & the local-only rule ---

    #[test]
    fn models_url_adds_v1_once() {
        assert_eq!(
            models_url("http://127.0.0.1:11434"),
            "http://127.0.0.1:11434/v1/models"
        );
        assert_eq!(
            models_url("http://127.0.0.1:11434/"),
            "http://127.0.0.1:11434/v1/models"
        );
        // Already names /v1: do not add it a second time.
        assert_eq!(
            models_url("http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434/v1/models"
        );
    }

    #[test]
    fn ensure_local_refuses_remote_urls() {
        assert!(ensure_local("http://127.0.0.1:11434".to_string()).is_ok());
        assert!(ensure_local("http://localhost:1234".to_string()).is_ok());
        assert!(
            ensure_local("http://8.8.8.8".to_string()).is_err(),
            "a public host"
        );
        assert!(
            ensure_local("https://127.0.0.1:11434".to_string()).is_err(),
            "this reqwest has no TLS, so https is not an http url"
        );
        assert!(
            ensure_local("ftp://127.0.0.1".to_string()).is_err(),
            "not a page url"
        );
    }

    // --- model list & the usable split ---

    #[test]
    fn embedding_filter_splits_usable_from_listed() {
        let body: String =
            "{\"data\":[{\"id\":\"qwen3:8b\"},{\"id\":\"bge-m3-embed\"},{\"id\":\"nomic-embed-text\"}]}"
                .to_string();
        let (models, usable) = parse_model_list(200, body.as_str().to_string());
        assert_eq!(
            models,
            vec![
                "qwen3:8b".to_string(),
                "bge-m3-embed".to_string(),
                "nomic-embed-text".to_string(),
            ]
        );
        // An embedding id is listed but cannot answer chat, so it is not usable for documents.
        assert_eq!(usable, vec!["qwen3:8b".to_string()]);

        // A non-2xx answer carries no list (reachability is the status, not the body).
        let (none, none_usable) = parse_model_list(500, body.as_str().to_string());
        assert!(none.is_empty() && none_usable.is_empty());
    }

    // --- pull line normalisation (pure) ---

    #[test]
    fn normalise_pull_line_maps_ollama_stages() {
        assert_eq!(
            normalise_pull_line("{\"status\":\"pulling manifest\"}".to_string()),
            json!({"stage": "pulling manifest"})
        );
        assert_eq!(
            normalise_pull_line(
                "{\"status\":\"downloading abc: 42%\",\"completed\":1024,\"total\":2048}"
                    .to_string()
            ),
            json!({"stage": "downloading", "total": 2048, "completed": 1024})
        );
        assert_eq!(
            normalise_pull_line("{\"status\":\"success\"}".to_string()),
            json!({"stage": "success"})
        );
        // An error line wins and carries the reason.
        assert_eq!(
            normalise_pull_line("{\"error\":\"manifest not found\"}".to_string()),
            json!({"stage": "error", "error": "manifest not found"})
        );
        // Not JSON at all: never dropped, surfaced as an "other" line.
        assert_eq!(
            normalise_pull_line("hello".to_string()),
            json!({"stage": "other", "status": "hello"})
        );
    }

    #[test]
    fn drain_lines_carries_the_tail_across_chunks() {
        // One JSON line split over two chunks. The first chunk holds no whole line: it returns
        // an empty set plus the unfinished tail. `drain_lines` does not remember the tail - the
        // CALLER rejoins it with the next chunk, which is the ownership hand-off the by-value
        // signature is built for.
        let first: Vec<u8> = "{\"s\":".to_string().as_bytes().to_vec();
        let (complete1, tail1) = drain_lines(first);
        assert!(complete1.is_empty(), "no whole line in the first chunk");
        assert_eq!(tail1, "{\"s\":".to_string().as_bytes().to_vec());

        // The caller appends the next chunk onto the kept tail; now both lines are whole.
        let next: Vec<u8> = "\"a\"}\n{\"s\":\"b\"}\n".to_string().as_bytes().to_vec();
        let mut combined: Vec<u8> = tail1.clone();
        combined.extend(next);
        let (complete2, tail2) = drain_lines(combined);
        assert_eq!(
            complete2,
            vec!["{\"s\":\"a\"}".to_string(), "{\"s\":\"b\"}".to_string(),]
        );
        assert!(tail2.is_empty(), "the joined buffer ended on a newline");
    }

    #[test]
    fn pull_stream_failed_covers_every_failure_mode() {
        let ok = PullStream {
            lines: Vec::new(),
            saw_success: true,
            saw_error: false,
            read_failed: false,
        };
        assert!(
            !pull_stream_failed(ok),
            "a confirmed success is not a failure"
        );
        let read = PullStream {
            lines: Vec::new(),
            saw_success: true,
            saw_error: false,
            read_failed: true,
        };
        assert!(pull_stream_failed(read), "the body read failed mid-stream");
        let err = PullStream {
            lines: Vec::new(),
            saw_success: false,
            saw_error: true,
            read_failed: false,
        };
        assert!(
            pull_stream_failed(err),
            "the server reported an error stage"
        );
        let cut = PullStream {
            lines: Vec::new(),
            saw_success: false,
            saw_error: false,
            read_failed: false,
        };
        assert!(
            pull_stream_failed(cut),
            "the stream ended before ever reaching success"
        );
    }

    // --- streaming a pull against a local server (wiremock) ---

    #[tokio::test]
    async fn a_pull_stream_ends_in_normalised_lines() {
        let server = MockServer::start().await;
        let ndjson: String =
            "{\"status\":\"pulling manifest\"}\n{\"status\":\"downloading abc: 42%\",\"completed\":1024,\"total\":2048}\n{\"status\":\"success\"}\n"
                .to_string();
        Mock::given(method("POST"))
            .and(path("/api/pull"))
            .respond_with(ResponseTemplate::new(200).set_body_string(ndjson))
            .mount(&server)
            .await;
        let response = start_pull(
            download_client(),
            server.uri().to_string(),
            "qwen3:8b".to_string(),
        )
        .await;
        assert!(response.is_ok(), "a 200 pull request yields a stream");
        let stream = consume_pull_stream(response.unwrap()).await;
        assert_eq!(stream.lines.len(), 3, "three normalised lines");
        let last_stage: String = stream
            .lines
            .get(2)
            .expect("third line")
            .get("stage")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        assert_eq!(last_stage, "success");
        assert!(!pull_stream_failed(stream), "the server confirmed success");
    }

    #[tokio::test]
    async fn consume_pull_stream_marks_an_incomplete_body_as_not_done() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/pull"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                "{\"status\":\"downloading abc: 10%\",\"completed\":1,\"total\":100}\n",
            ))
            .mount(&server)
            .await;
        let response = start_pull(
            download_client(),
            server.uri().to_string(),
            "qwen3:8b".to_string(),
        )
        .await;
        let stream = consume_pull_stream(response.unwrap()).await;
        assert!(!stream.saw_success, "no success stage in the body");
        assert!(
            pull_stream_failed(stream),
            "a body that stopped early is not a finished model"
        );
    }

    #[tokio::test]
    async fn consume_pull_stream_hands_each_line_over_as_it_arrives() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/pull"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string(
                    "{\"status\":\"pulling manifest\"}\n{\"status\":\"success\"}\n",
                ),
            )
            .mount(&server)
            .await;
        let response = start_pull(
            download_client(),
            server.uri().to_string(),
            "qwen3:8b".to_string(),
        )
        .await;
        // The CLI's live-progress path: every line is handed to `emit` as the stream delivers it.
        let mut delivered: Vec<String> = Vec::new();
        let collector = |line: Value| {
            let stage: String = line
                .get("stage")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            delivered.push(stage);
        };
        let stream = consume_pull_stream_to(response.unwrap(), collector).await;
        assert_eq!(
            delivered,
            vec!["pulling manifest".to_string(), "success".to_string()]
        );
        assert_eq!(
            stream.lines.len(),
            delivered.len(),
            "emit saw exactly the stream's lines"
        );
    }

    #[tokio::test]
    async fn a_server_without_a_pull_endpoint_gives_one_sentence() {
        // LM Studio has no /api/pull: a non-2xx request becomes a one-sentence failure, not a stream.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/pull"))
            .respond_with(ResponseTemplate::new(404).set_body_string("404 Not Found"))
            .mount(&server)
            .await;
        match start_pull(
            download_client(),
            server.uri().to_string(),
            "qwen3:8b".to_string(),
        )
        .await
        {
            Err(reason) => assert_eq!(reason.trim(), "404 Not Found"),
            Ok(_) => panic!("a 404 from /api/pull must be a failure, not a stream"),
        }
    }

    #[tokio::test]
    async fn a_closed_port_is_not_found_fast() {
        // Nothing is listening: the download client's connect_timeout (2 s) still bounds this.
        let started = std::time::Instant::now();
        assert!(
            start_pull(
                download_client(),
                "http://127.0.0.1:1".to_string(),
                "qwen3:8b".to_string()
            )
            .await
            .is_err()
        );
        assert!(
            std::time::Instant::now() - started < std::time::Duration::from_secs(10),
            "the download client still fails a dead port fast"
        );
    }

    // --- detect against a fake server (wiremock) ---

    #[tokio::test]
    async fn detect_lists_models_and_usable_from_a_fake_server() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"data": [{"id": "qwen3:8b"}, {"id": "bge-m3-embed"}]})),
            )
            .mount(&server)
            .await;
        let endpoint = Endpoint {
            runtime: "custom".to_string(),
            url: server.uri().to_string(),
        };
        let detection = detect(vec![endpoint], shared_model::SharedModel::default()).await;
        assert_eq!(detection.runtimes.len(), 1);
        let found = detection.runtimes.first().expect("one endpoint probed");
        assert!(found.reachable, "the fake server answers the listing");
        assert_eq!(
            found.usable,
            vec!["qwen3:8b".to_string()],
            "the embedding id is listed but not usable"
        );
        assert_eq!(found.models.len(), 2);
    }

    #[tokio::test]
    async fn the_shared_block_carries_reachable() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": []})))
            .mount(&server)
            .await;
        let shared = shared_model::SharedModel {
            runtime: Some("ollama".to_string()),
            url: Some(server.uri().to_string()),
            model: Some("qwen3:8b".to_string()),
            set_by: Some("triage mail".to_string()),
            updated: Some("2026-11-25T09:00:00Z".to_string()),
        };
        // No endpoints to probe; only the shared block is reported.
        let block = detect(Vec::new(), shared)
            .await
            .shared
            .expect("a complete shared file gives a block");
        assert!(block.reachable, "the stored url answers now");
        assert_eq!(block.model, "qwen3:8b".to_string());
        assert_eq!(block.set_by, "triage mail".to_string());

        // The other app chose it, but its server is off: the block still appears, `reachable` false.
        let off = detect(
            Vec::new(),
            shared_with_url("http://127.0.0.1:1".to_string()),
        )
        .await
        .shared
        .expect("block present even when the server is off");
        assert!(!off.reachable, "a dead stored url is data, not an error");
    }

    #[tokio::test]
    async fn the_shared_block_refuses_a_public_url_without_requesting_it() {
        // Review finding 2 (LET-165): the shared `model.toml` url is NOT validated by `shared_model::read`,
        // so a public host there must not make `detect` send a request there. `ensure_local` runs first
        // and short-circuits the probe; the block reports `reachable = false` (unreachable) and carries
        // its stored values as data. Mirrors `status::refused_base_url_is_unreachable` for the shared path.
        let shared = shared_model::SharedModel {
            runtime: Some("ollama".to_string()),
            url: Some("http://8.8.8.8/v1".to_string()),
            model: Some("qwen3:8b".to_string()),
            set_by: Some("triage mail".to_string()),
            updated: Some("2026-11-25T09:00:00Z".to_string()),
        };
        let block = detect(Vec::new(), shared)
            .await
            .shared
            .expect("a complete shared file gives a block");
        assert!(
            !block.reachable,
            "a public stored url is refused: reported unreachable, never requested"
        );
        assert_eq!(
            block.model,
            "qwen3:8b".to_string(),
            "the stored model still shows as data"
        );
        assert_eq!(
            block.set_by,
            "triage mail".to_string(),
            "the other app's attribution still shows"
        );
    }

    fn shared_with_url(url: String) -> shared_model::SharedModel {
        shared_model::SharedModel {
            runtime: None,
            url: Some(url),
            model: Some("qwen3:8b".to_string()),
            set_by: None,
            updated: None,
        }
    }

    // --- overridden (rag-only: this app's own [llm] keys win over the shared file) ---

    #[test]
    fn overridden_reflects_written_llm_keys() {
        let dir = tempfile::tempdir().unwrap();
        let file: PathBuf = dir.path().join("config.toml");

        std::fs::write(&file, "[llm]\nmodel = \"x\"\n").unwrap();
        assert!(
            llm_keys_written(&file),
            "a written [llm] model means this app overrides the shared file"
        );

        std::fs::write(&file, "[llm]\nbase_url = \"http://127.0.0.1:9999/v1\"\n").unwrap();
        assert!(
            llm_keys_written(&file),
            "a written [llm] base_url counts too"
        );

        std::fs::write(&file, "[classify]\ntypes = [\"x\"]\n").unwrap();
        assert!(
            !llm_keys_written(&file),
            "no [llm] keys: the shared file still rules"
        );

        std::fs::write(&file, "").unwrap();
        assert!(!llm_keys_written(&file), "an empty config is unwritten");
        assert!(
            !llm_keys_written(&dir.path().join("missing.toml")),
            "no file at all is unwritten"
        );
    }

    // --- model save (writes the shared file) ---

    #[test]
    fn save_writes_the_shared_file_and_refuses_bad_values() {
        let dir = tempfile::tempdir().unwrap();
        let file: PathBuf = dir.path().join("model.toml");

        assert!(
            save_to_shared(
                &file,
                "ollama".to_string(),
                "http://127.0.0.1:11434".to_string(),
                "qwen3:8b".to_string()
            )
            .is_ok(),
            "a valid choice saves"
        );
        let saved = shared_model::read(&file);
        assert_eq!(saved.chat_model(), Some("qwen3:8b"));
        assert_eq!(saved.set_by.as_deref().unwrap_or(""), "rag docs");
        assert!(saved.updated.is_some(), "the save stamps an updated time");

        // Refusals leave the file exactly as it was (the local rule and validation run first).
        assert!(
            save_to_shared(
                &file,
                "ollama".to_string(),
                "http://8.8.8.8".to_string(),
                "qwen3:8b".to_string()
            )
            .is_err(),
            "a remote url is refused"
        );
        assert!(
            save_to_shared(
                &file,
                "cloud".to_string(),
                "http://127.0.0.1:11434".to_string(),
                "qwen3:8b".to_string()
            )
            .is_err(),
            "an unknown runtime is refused"
        );
        assert!(
            save_to_shared(
                &file,
                "ollama".to_string(),
                "http://127.0.0.1:11434".to_string(),
                "".to_string()
            )
            .is_err(),
            "a blank model is refused"
        );
        assert_eq!(
            shared_model::read(&file).chat_model(),
            Some("qwen3:8b"),
            "a refusal changes nothing"
        );
    }

    #[test]
    fn now_seconds_is_the_real_clock() {
        // rusqlite's unixepoch(): after 2024, comfortably positive.
        assert!(
            now_seconds() > 1_700_000_000u64,
            "a plausible present-day timestamp"
        );
    }

    // --- JSON shape locks (the desktop parses these) ---

    #[test]
    fn detect_json_shape_is_locked() {
        // Built from fixed values only: no clock, no network. A missing config file => not overridden.
        let detection = Detection {
            runtimes: vec![
                Found {
                    runtime: "ollama".to_string(),
                    url: "http://127.0.0.1:11434".to_string(),
                    reachable: true,
                    models: vec!["qwen3:8b".to_string()],
                    usable: vec!["qwen3:8b".to_string()],
                    error: None,
                },
                Found {
                    runtime: "lmstudio".to_string(),
                    url: "http://127.0.0.1:1234".to_string(),
                    reachable: false,
                    models: Vec::new(),
                    usable: Vec::new(),
                    error: Some("timed out".to_string()),
                },
            ],
            shared: None,
        };
        let config = Config::default();
        let file = PathBuf::from("/nonexistent/lets-rag-docs/config.toml");
        let js: String = serde_json::to_string(&detect_json(&detection, &config, &file)).unwrap();
        lock("model-detect-found.json", &js);
    }

    #[test]
    fn save_json_shape_is_locked() {
        // `save_json` borrows its three strings, so hold them in locals and pass references.
        let runtime: String = "ollama".to_string();
        let url: String = "http://127.0.0.1:11434".to_string();
        let model: String = "qwen3:8b".to_string();
        let v = save_json(&runtime, &url, &model);
        let js: String = serde_json::to_string(&v).unwrap();
        lock("model-save.json", &js);
    }

    #[test]
    fn pull_line_shape_is_locked() {
        // The NDJSON the app streams, locked so the fake engine and TS tests replay byte-for-byte.
        let lines: Vec<Value> = vec![
            normalise_pull_line("{\"status\":\"pulling manifest\"}".to_string()),
            normalise_pull_line(
                "{\"status\":\"downloading abc: 42%\",\"completed\":1024,\"total\":2048}"
                    .to_string(),
            ),
            normalise_pull_line("{\"status\":\"success\"}".to_string()),
        ];
        let parts: Vec<String> = lines
            .iter()
            .map(|line| serde_json::to_string(line).unwrap())
            .collect();
        let with_trailing: String = parts.join("\n") + "\n";
        lock("model-pull.jsonl", &with_trailing);
    }
}
