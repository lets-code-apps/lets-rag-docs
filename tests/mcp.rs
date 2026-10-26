//! Speaks MCP over stdio to the real binary. Needs no Qdrant or embed service: `tools/list`
//! and a rejected empty query never reach them.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

#[test]
fn lists_search_docs_and_rejects_empty_query() {
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
    assert_eq!(tools.as_array().unwrap().len(), 1);
    assert_eq!(tools[0]["name"], "search_docs");
    let props = &tools[0]["inputSchema"]["properties"];
    assert_eq!(props["limit"]["default"], 5);
    assert_eq!(tools[0]["inputSchema"]["required"], json!(["query"]));

    send(json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "search_docs", "arguments": {"query": "  "}}}));
    let result = recv()["result"].clone();
    assert_eq!(result["isError"], true);

    drop(send);
    let _ = child.kill();
    let _ = child.wait();
}
