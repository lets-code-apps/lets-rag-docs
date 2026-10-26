"""Vector search over the OCR'd documents: bge-m3 embeddings (dense + sparse) in Qdrant.

Usage:
  .venv/bin/python rag.py ingest              # (re)build the index from data/ocr
  .venv/bin/python rag.py search "question"   # show the best matching chunks
  .venv/bin/python rag.py eval                # did the right document come back? (evals/rag.jsonl)
"""
import json
import sys
from pathlib import Path

from FlagEmbedding import BGEM3FlagModel
from qdrant_client import QdrantClient, models

ROOT = Path(__file__).parent
OCR = ROOT / "data" / "ocr"
COLLECTION = "documents"
CHUNK_CHARS = 1500  # ponytail: ~350 tokens counted in chars; count tokens if chunks get cut badly
OVERLAP_LINES = 3
TOP_DOCS = 5


def chunks(text):
    """Split on line boundaries so table rows stay whole, repeating a few lines between chunks."""
    out, cur = [], []
    for line in filter(str.strip, text.splitlines()):
        if cur and sum(len(l) + 1 for l in cur) + len(line) > CHUNK_CHARS:
            out.append("\n".join(cur))
            cur = cur[-OVERLAP_LINES:]
        cur.append(line)
    return out + ["\n".join(cur)] if cur else out


def embed(model, texts):
    e = model.encode(texts, return_dense=True, return_sparse=True)
    sparse = [models.SparseVector(indices=[int(t) for t in w], values=[float(v) for v in w.values()])
              for w in e["lexical_weights"]]
    return [d.tolist() for d in e["dense_vecs"]], sparse


def ingest(model, client):
    # ponytail: full rebuild every run (seconds for tens of docs); go incremental by file hash at hundreds
    if client.collection_exists(COLLECTION):
        client.delete_collection(COLLECTION)
    client.create_collection(COLLECTION,
                             vectors_config={"dense": models.VectorParams(size=1024, distance=models.Distance.COSINE)},
                             sparse_vectors_config={"sparse": models.SparseVectorParams()})
    points = []
    for f in sorted(OCR.rglob("*.txt")):
        # "Car loan/Repayment schedule.pdf.text.txt" -> "Car loan/Repayment schedule"
        source = str(f.relative_to(OCR)).rsplit(".", 3)[0]
        parts = chunks(f.read_text())
        # the document's path goes in front of every chunk, so "Car loan" is findable in all of them
        dense, sparse = embed(model, [f"{source}\n{c}" for c in parts])
        for n, (c, d, s) in enumerate(zip(parts, dense, sparse)):
            points.append(models.PointStruct(id=len(points), vector={"dense": d, "sparse": s},
                                             payload={"text": c, "source": source, "file": str(f.relative_to(OCR)),
                                                      "chunk": n}))
        print(f"{len(parts):>3} chunks  {source}")
    client.upsert(COLLECTION, points)
    print(f"{len(points)} chunks indexed")


def search(model, client, question, limit=20):
    """Hybrid search: meaning (dense) and keywords (sparse), merged by rank (RRF)."""
    (dense,), (sparse,) = embed(model, [question])
    return client.query_points(COLLECTION, limit=limit, query=models.FusionQuery(fusion=models.Fusion.RRF),
                               prefetch=[models.Prefetch(query=dense, using="dense", limit=limit),
                                         models.Prefetch(query=sparse, using="sparse", limit=limit)]).points


def top_docs(hits):
    return list(dict.fromkeys(h.payload["source"] for h in hits))[:TOP_DOCS]


def run_eval(model, client):
    rows = [json.loads(l) for l in (ROOT / "evals" / "rag.jsonl").read_text().splitlines() if l.strip()]
    found = 0
    for r in rows:
        docs = top_docs(search(model, client, r["question"]))
        rank = docs.index(r["source"]) + 1 if r["source"] in docs else None
        found += rank is not None
        print(f"{'ok' if rank else 'MISS':<4} rank={rank or '-'}  [{r['lang']}] {r['question']}")
        if not rank:
            print(f"       expected: {r['source']}\n       got:      {docs}")
    print(f"\nright document in top {TOP_DOCS}: {found}/{len(rows)}")


if __name__ == "__main__":
    cmd = sys.argv[1]
    model = BGEM3FlagModel("BAAI/bge-m3", use_fp16=True, devices="mps")
    client = QdrantClient(url="http://localhost:6333")  # docker compose up -d
    if cmd == "ingest":
        ingest(model, client)
    elif cmd == "eval":
        run_eval(model, client)
    else:
        for h in search(model, client, sys.argv[2])[:TOP_DOCS]:
            print(f"\n{h.score:.3f}  {h.payload['source']}  (chunk {h.payload['chunk']})\n{h.payload['text'][:300]}")
    client.close()
