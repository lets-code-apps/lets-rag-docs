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
use anyhow::anyhow;
use crate::config::{Config, Written};
use crate::shared_model;
use crate::status::rfc3339_utc;

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
    ];
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
pub async fn detect(
    endpoints: Vec<Endpoint>,
    shared: shared_model::SharedModel,
) -> Detection {
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
                items.push(probe_endpoint(&client, &endpoint).await);
            }
            items
        }
    };

    // The shared block: probe the stored base url. A complete file gives one even when
    // the server is off, flagged by `reachable`.
    let shared_block: Option<SharedBlock> = match shared.chat_base_url() {
        None => None,
        Some(base_url) => {
            let reachable = probe_listing(&client, base_url.to_string()).await.is_ok();
            Some(SharedBlock {
                runtime: shared.runtime.clone().unwrap_or(String::new()),
                url: shared.url.clone().unwrap_or(String::new()),
                // `chat_model` borrows from `shared`; this field owns a copy.
                model: shared.chat_model().unwrap_or("").to_string(),
                set_by: shared.set_by.clone().unwrap_or(String::new()),
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
        .expect("a basic HTTP client always builds");
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
        .expect("a basic HTTP client always builds");
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
async fn probe_listing(
    client: &reqwest::Client,
    url: String,
) -> Result<(u16, String), String> {
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
            Ok(list) => list.data.into_iter().map(|entry| entry.id.to_string()).collect(),
        },
        _ => Vec::new(),
    };
    // Embedding models are listed but cannot answer chat; the desktop needs both lists
    // to tell "found, nothing usable" from "nothing installed".
    let usable = ids.clone().into_iter().filter(|id| !id.contains("embed")).collect();
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
    root.to_string();
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
    let request = client.post(format!("{}/api/pull", url.trim_end_matches('/'))).body(body);
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
    let conn: rusqlite::Connection = rusqlite::Connection::open_in_memory();
    let seconds: i64 = conn.query_scalar("SELECT unixepoch()").unwrap_or(0);
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

/// What a `model` command prints: the JSON for the app and the short text for people.
struct Outcome {
    json: Value,
    text: String,
}

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
        println!("{}", serde_json::to_string(&detect_json(&detection, config, path))?);
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
            lines.push(format!("{runtime} at {url} reachable, {usable}", runtime = found.runtime, url = found.url, usable = usable));
        } else {
            let why = found.error.clone().unwrap_or("unreachable".to_string());
            lines.push(format!("{runtime} at {url} not reachable ({why})", runtime = found.runtime, url = found.url, why = why));
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
    match save_to_shared(shared, runtime, url, model) {
        Err(reason) => {
            if json {
                println!("{}", failure_json(anyhow!(reason)));
                std::process::exit(1);
            }
            return Err(anyhow!(reason));
        }
        Ok(()) => {},
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
pub async fn pull(
    url: Option<String>,
    model: String,
    json: bool,
) -> anyhow::Result<()> {
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
