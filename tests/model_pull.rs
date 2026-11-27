//! Fresh-process `model pull` (LET-165, ported from lets-triage-mail's model_pull.rs).
//!
//! The one property an in-process unit test cannot prove is that a standalone `model pull` writes
//! AND flushes each NDJSON progress line the moment the server sends it, rather than buffering
//! stdout until the process exits. A raw loopback HTTP server streams one `downloading` line and
//! then holds the connection open for two whole seconds before the `success` line: the child
//! cannot exit before the body ends, so a first line that reaches us inside the hold is live,
//! flush-per-line progress (see `consume_pull_stream_to` and the emit closure in `model_setup`).
//!
//! rag's `reqwest` is http-only (no TLS feature), so triage-mail's crypto-provider half does not
//! apply here. std sockets only: no new dependencies, no real Ollama, no network beyond loopback.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::thread::{sleep, spawn};
use std::time::{Duration, Instant};

/// The binary `cargo` builds for integration tests (the real `lets-rag-docs` CLI).
const BIN: &str = env!("CARGO_BIN_EXE_lets-rag-docs");

#[test]
fn pull_progress_reaches_stdout_while_the_download_is_still_running() {
    // `model pull` must hand each line to stdout the instant it arrives. The test server sends
    // ONE `downloading` line and holds the connection open two seconds before `success`. A CLI
    // that buffered could not emit before the child exits, and the child cannot exit before the
    // server closes the body - so a first line well inside the hold can only be live progress.
    let server = TcpListener::bind("127.0.0.1:0").expect("the test server binds a free port");
    let port = server.local_addr().expect("the bound address").port();
    let base = format!("http://127.0.0.1:{port}");

    // A raw HTTP/1.1 answer with no Content-Length and `Connection: close`: the body runs to the
    // socket close, so reqwest streams it as it arrives - the shape a real model download has.
    // The server first swallows the CLI's request: a socket closed with unread request data
    // left over resets the connection, and reqwest would then report a broken connection.
    let streamer = spawn(move || {
        let (mut client, _) = server
            .accept()
            .expect("the CLI connects to the test server");
        let mut raw: Vec<u8> = vec![];
        let mut one: Vec<u8> = vec![0u8];
        // Request headers, byte by byte, up to the CRLF CRLF that ends them.
        loop {
            if client.read(&mut one[..]).unwrap_or(0) == 0 {
                break;
            }
            raw.push(one[0]);
            let n = raw.len();
            if n >= 4
                && raw[n - 4] == b'\r'
                && raw[n - 3] == b'\n'
                && raw[n - 2] == b'\r'
                && raw[n - 1] == b'\n'
            {
                break;
            }
        }
        // Then exactly the body the `content-length` header declares.
        let headers = String::from_utf8_lossy(&raw[..]).to_lowercase();
        let mut body_bytes = 0;
        for line in headers.lines() {
            if let Some(pair) = line.split_once(":")
                && pair.0.trim() == "content-length"
            {
                body_bytes = pair.1.trim().parse::<usize>().unwrap_or(0);
                break;
            }
        }
        for _ in 0..body_bytes {
            if client.read(&mut one[..]).unwrap_or(0) == 0 {
                break;
            }
        }
        // Now the streamed answer: headers, one progress line, a two-second stall, then success.
        client
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nConnection: close\r\n\r\n"
            )
            .expect("the test server sends its headers");
        client
            .write_all(b"{\"status\":\"downloading abc123def456\"}\n")
            .expect("the progress line");
        client.flush().expect("the progress line is on the wire");
        sleep(Duration::from_secs(2));
        client
            .write_all(b"{\"status\":\"success\"}\n")
            .expect("the success line");
        client.flush().expect("the success line is on the wire");
        // `client` closes with this scope: only now does the CLI see the body end.
    });

    let mut child = Command::new(BIN)
        .args([
            "model",
            "pull",
            "--json",
            "--url",
            base.as_str(),
            "--",
            "qwen3:4b",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the CLI starts");

    // Read the child's live pipe up to the end of the FIRST line, with 1.5 s of patience: generous
    // for a slow CI runner, still inside the server's two-second hold. One byte at a time, so the
    // read cannot swallow the `success` line and hide the regression.
    let started_at = Instant::now();
    let mut raw: Vec<u8> = vec![];
    let mut one: Vec<u8> = vec![0u8];
    loop {
        if Instant::now() - started_at > Duration::from_millis(1500) {
            break;
        }
        let read = child
            .stdout
            .as_mut()
            .expect("the CLI's stdout is piped")
            .read(&mut one[..]);
        if read.unwrap_or(0) == 0 {
            break; // EOF with no line: the CLI exited without printing, the buffered defect.
        }
        raw.push(one[0]);
        if one[0] == b'\n' {
            break;
        }
    }
    let waited: Duration = Instant::now() - started_at;
    let first_line = String::from_utf8_lossy(&raw[..]).to_string();

    // Three assertions, in the order they separate the failure modes: nothing printed (a stall
    // or a broken request), too late (buffered until the body ended), and the wrong line.
    if !first_line.contains("\n") {
        panic!("no progress line reached the CLI inside the download window; waited {waited:?}");
    }
    if waited > Duration::from_millis(1500) {
        panic!("the first progress line only arrived once the download was over: {waited:?}");
    }
    if !first_line.contains("downloading") || first_line.contains("success") {
        panic!("the first line was not live download progress: {first_line:?}");
    }

    // Drain the rest of the pipe to EOF: the live-first download must still reach its `success`
    // stage. The exit code is not asserted: this test ends the body by closing, which the CLI
    // correctly reports as an interrupted read; clean-body exit codes are covered in model_setup.
    let mut rest: Vec<u8> = vec![];
    let drain_started = Instant::now();
    loop {
        if Instant::now() - drain_started > Duration::from_secs(10) {
            break;
        }
        let read = child
            .stdout
            .as_mut()
            .expect("the CLI's stdout is piped")
            .read(&mut one[..]);
        if read.unwrap_or(0) == 0 {
            break;
        }
        rest.push(one[0]);
    }
    let finished = String::from_utf8_lossy(&rest[..]).to_string();
    if !finished.contains("success") {
        panic!("the live-first download never reached its success stage: {finished:?}");
    }
    let _ = child.wait();
    let _ = streamer.join();
}
