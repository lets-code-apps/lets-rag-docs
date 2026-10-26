"""Local embedding service: bge-m3 dense + sparse vectors over HTTP, for the Rust side.

Usage:
  .venv/bin/python embed_server.py      # listens on 127.0.0.1:8100

  POST /embed  {"texts": ["...", ...]}
  -> {"dense": [[1024 floats], ...], "sparse": [{"indices": [...], "values": [...]}, ...]}
  GET /health  -> {"ok": true}
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

from FlagEmbedding import BGEM3FlagModel

HOST, PORT = "127.0.0.1", 8100  # localhost only: document text never leaves the machine

model = None  # loaded once in main(), before the server starts accepting requests


def embed(texts):
    e = model.encode(texts, return_dense=True, return_sparse=True)
    # same conversion as rag.py embed(): token-id string keys -> int, numpy floats -> float
    sparse = [{"indices": [int(t) for t in w], "values": [float(v) for v in w.values()]}
              for w in e["lexical_weights"]]
    return {"dense": [d.tolist() for d in e["dense_vecs"]], "sparse": sparse}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            return self.send_json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            texts = body["texts"]
            if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self.send_json(400, {"error": 'expected JSON {"texts": ["...", ...]} with non-empty strings list'})
        self.send_json(200, embed(texts))


def main():
    global model
    model = BGEM3FlagModel("BAAI/bge-m3", use_fp16=True, devices="mps")
    # HTTPServer (not Threading*) handles one request at a time: one model, one GPU, no locking needed
    server = HTTPServer((HOST, PORT), Handler)
    print(f"embed server on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
