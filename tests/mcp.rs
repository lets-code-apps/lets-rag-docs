//! Speaks MCP over stdio to the real binary. Needs no Qdrant or embed service: `tools/list`
//! and the rejected calls (empty query, bad path) never reach them.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

#[test]
fn lists_both_tools_and_rejects_bad_arguments() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lets-rag-docs"))
        .args(["--config", "/nonexistent/lets-rag-docs.toml", "mcp"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut send = |msg: Value| writeln!(stdin, "{msg}").unwrap();
    // Every stdout line must be a JSON-RPC message; anything else would break the client.
    let mut recv = || {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        serde_json::from_str::<Value>(&line).unwrap()
    };

    send(
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "test", "version": "0"}}}),
    );
    let init = recv();
    assert!(
        init["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("data")
    );
    send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));

    send(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}));
    let tools = recv()["result"]["tools"].clone();
    let listed = tools.as_array().unwrap();
    assert_eq!(listed.len(), 2);
    // Which order the server lists them in is its business: look them up by name.
    let search = listed.iter().find(|t| t["name"] == "search_docs").unwrap();
    assert_eq!(search["inputSchema"]["properties"]["limit"]["default"], 5);
    assert_eq!(search["inputSchema"]["required"], json!(["query"]));
    let document = listed.iter().find(|t| t["name"] == "add_document").unwrap();
    assert_eq!(document["inputSchema"]["required"], json!(["path"]));

    send(json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "search_docs", "arguments": {"query": "  "}}}));
    let result = recv()["result"].clone();
    assert_eq!(result["isError"], true);

    // add_document rejects a relative path before it touches the filesystem.
    send(json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
        "params": {"name": "add_document", "arguments": {"path": "receipt.pdf"}}}));
    let relative = recv()["result"].clone();
    assert_eq!(relative["isError"], true);
    assert!(
        relative["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("absolute")
    );

    // A missing absolute path is an error too: nothing is copied, OCR'd or indexed.
    send(json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
        "params": {"name": "add_document", "arguments": {"path": "/nonexistent/receipt.pdf"}}}));
    let missing = recv()["result"].clone();
    assert_eq!(missing["isError"], true);
    assert!(
        missing["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("cannot find")
    );

    let _ = child.kill();
    let _ = child.wait();
}
