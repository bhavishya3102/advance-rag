# Advance RAG — PDF Q&A with Qdrant, BullMQ & OpenAI

An **Advanced RAG (Retrieval Augmented Generation)** pipeline in Node.js.

Upload a PDF → it gets parsed, chunked, embedded and stored in a vector DB (asynchronously, via a queue).
Ask a question → the query is expanded into multiple variants (rewriting, step-back, HyDE, sub-queries),
each variant searches the vector DB, the ranked lists are fused with **Reciprocal Rank Fusion**, and the
top chunks are handed to the LLM to write a grounded answer.

Nothing blocks the HTTP request: heavy work (PDF parsing, embeddings, LLM calls) runs in a **separate
worker process**, so the API stays fast and jobs can retry on failure.

---

## Table of Contents

- [Architecture](#architecture)
- [The two flows](#the-two-flows)
  - [1. Indexing flow](#1-indexing-flow-pdf--vectors)
  - [2. Query flow](#2-query-flow-question--answer)
- [Advanced RAG techniques used](#advanced-rag-techniques-used)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Running the project](#running-the-project)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Next steps](#next-steps)

---

## Architecture

Three processes + two containers:

```
                        ┌──────────────────────────────┐
   POST /index (PDF) ──►│                              │
   POST /query        ──►│   Express API  (src/index.js)│
   GET  /query/:id    ──►│      port 8000               │
                        └───────────┬──────────────────┘
                                    │ add job
                                    ▼
                        ┌──────────────────────────────┐
                        │   Redis  (BullMQ queues)      │   docker :6379
                        │   • file-indexing             │
                        │   • query                     │
                        └───────────┬──────────────────┘
                                    │ consume job
                                    ▼
                        ┌──────────────────────────────┐
                        │   Worker  (src/worker.js)     │
                        │   indexer.js  /  retriever.js │
                        └────────┬───────────┬─────────┘
                                 │           │
                    embeddings + chat        │ upsert / search
                                 ▼           ▼
                        ┌────────────┐  ┌──────────────────┐
                        │  OpenAI    │  │  Qdrant          │  docker :6333
                        │  API       │  │  collection:     │
                        └────────────┘  │  "documents"     │
                                        └──────────────────┘
```

**Why a queue?** Parsing a 200-page PDF + embedding 300 chunks takes minutes. The API returns
`202 Accepted` with a `jobId` immediately; the worker does the slow part with automatic retries and
exponential backoff.

---

## The two flows

### 1. Indexing flow (PDF → vectors)

```
POST /index  (multipart form-data, field: file)
      │
      ├─ multer: validate mimetype = application/pdf, max 25 MB
      ├─ save to  uploads/<timestamp>-<uuid>.pdf
      ├─ enqueueIndexingJob({ filePath, originalName, ... })   → queue "file-indexing"
      └─ respond 202 { jobId, file }                            ← request ends here
                    │
                    ▼  (worker process picks the job up)
      indexPdf()  in src/indexer.js
      │
      ├─ 1. ensureCollection()      create Qdrant collection if missing
      │                             (vector size = EMBEDDING_DIMENSIONS, distance = Cosine)
      ├─ 2. readPdfText()           pdf-parse → raw text
      ├─ 3. chunkText()             collapse whitespace, slice into ~1000-char chunks
      │                             with 200-char overlap, cutting on word boundaries
      ├─ 4. embedTexts(chunks)      OpenAI embeddings, batched 100 at a time
      ├─ 5. build points            { id: uuid, vector, payload: { text, source,
      │                               filePath, chunkIndex } }
      └─ 6. qdrant.upsert()         wait: true → written & searchable
      →  returns { chunks: N, collection }
```

Job options: `attempts: 3`, exponential backoff starting at 2s.

**Why overlap?** A chunk boundary can cut a sentence in half and destroy its meaning. A 200-char
overlap means every sentence appears whole in at least one chunk.

### 2. Query flow (question → answer)

```
POST /query  { "query": "..." }
      │
      ├─ enqueueQueryJob({ query })   → queue "query"
      └─ respond 202 { jobId, poll: "/query/<id>" }   ← request ends here

GET /query/:id   → { status: "waiting" | "active" | "completed" | "failed", result? }
                    (poll this until status === "completed")
                    │
                    ▼  (worker process)
      answerQuery()  in src/retriever.js
      │
      ├─ 1. retrieveChunks(query)    the advanced pipeline — see below
      ├─ 2. build context            "[Chunk 1] (source: x.pdf) ...\n\n[Chunk 2] ..."
      └─ 3. chat.completions         system prompt: answer ONLY from context,
                                     else say you don't know
      →  returns { query, queries, answer, sources[] }
```

Step 1 is where all the "advanced" work happens — `retrieveChunks()`, also in `src/retriever.js`:

```
retrieveChunks(query)
      │
      ├─ in parallel:
      │     queryRewriting(query)  ─► { rewritten, stepBack, subQueries[3] }   (JSON-schema mode)
      │     hydeDocument(query)    ─► a fake 3-5 sentence "answer passage"
      │
      ├─ 6 labelled query variants:
      │     rewritten · stepBack · hyde · subQuery1 · subQuery2 · subQuery3
      │
      ├─ embedTexts(all 6)                 one batched embeddings call
      ├─ 6 × qdrant.search(topK)           run in parallel
      │
      ├─ reciprocalRankFusion()
      │     score(chunk) = Σ over lists  1 / (RRF_K + rank_in_that_list)
      │     → a chunk that ranks decently for *several* variants beats a chunk
      │       that ranks #1 for only one
      │
      └─ keep top RETRIEVAL_FINAL_K chunks
      →  { queries: {original, rewritten, stepBack, hyde, subQueries}, chunks[] }
```

Each returned chunk carries `matchedBy: ["hyde", "subQuery2", ...]` so you can see *which* variant
found it — very handy for debugging retrieval quality.

---

## Advanced RAG techniques used

| Technique | Where | What it solves |
|---|---|---|
| **Chunking with overlap** | `indexer.js → chunkText()` | Prevents meaning being cut at chunk boundaries |
| **Query rewriting** | `retriever.js → queryRewriting()` | Fixes typos/grammar, makes a vague query self-contained |
| **Step-back prompting** | same call | Generates a broader background question → retrieves the conceptual context, not just the literal keywords |
| **Sub-query decomposition** | same call | A multi-part question is split into 3 focused questions, each retrieving its own evidence |
| **HyDE** (Hypothetical Document Embeddings) | `retriever.js → hydeDocument()` | A question and its answer look different in vector space. Embedding a *fake answer* lands nearer the real documents than embedding the bare question |
| **Reciprocal Rank Fusion (RRF)** | `retriever.js → reciprocalRankFusion()` | Merges 6 ranked lists into one without needing comparable raw scores — uses rank position only |
| **Structured output** | `queryRewriting()` | `response_format: json_schema, strict: true` → the model *cannot* return malformed JSON |
| **Async job queue + retries** | `queue.js`, `worker.js` | Slow/flaky work (network, LLM) retried with backoff, API never blocks |
| **Grounded generation** | `answerQuery()` | System prompt forces "answer ONLY from context, else say you don't know" → reduces hallucination |

---

## Prerequisites

| Requirement | Version | Note |
|---|---|---|
| Node.js | ≥ 18 (tested on v22) | ESM (`"type": "module"`) is used |
| Docker + Docker Compose | any recent | Runs Qdrant + Redis |
| OpenAI API key | — | Used for embeddings **and** chat |

> **Docker is not currently installed on this machine.** Install it first:
> ```bash
> # Ubuntu / Debian
> sudo apt update && sudo apt install -y docker.io docker-compose-v2
> sudo systemctl enable --now docker
> sudo usermod -aG docker $USER    # then log out and back in
> ```
> No Docker? See [Troubleshooting](#troubleshooting) for how to run Qdrant and Redis natively.

---

## Setup

```bash
# 1. install node dependencies   (already done ✅)
npm install

# 2. create your env file
cp .env.example .env

# 3. put your real key in .env
#    OPENAI_API_KEY=sk-...
```

`.env` and `uploads/` are git-ignored — the key never gets committed.

---

## Running the project

You need **three things running**, in this order:

```bash
# ── Terminal 1: infrastructure (Qdrant + Redis) ──
npm run services:up          # docker compose up -d
# Qdrant dashboard: http://localhost:6333/dashboard

# ── Terminal 2: API server ──
npm run dev                  # node --watch src/index.js
# 🚀 Server listening on http://localhost:8000

# ── Terminal 3: worker ──
npm run worker               # node src/worker.js
# 👷 Workers started (indexing + query). Waiting for jobs...
```

Stop the containers with `npm run services:down`.

### End-to-end smoke test

```bash
# health
curl http://localhost:8000/health
# → {"status":"ok"}

# 1. index a PDF
curl -F "file=@/path/to/your.pdf" http://localhost:8000/index
# → {"message":"File uploaded and queued for indexing","jobId":"1", ...}
#   watch Terminal 3:  📥 Indexing job 1 → 42 chunk(s) indexed  ✅

# 2. ask a question
curl -X POST http://localhost:8000/query \
     -H "Content-Type: application/json" \
     -d '{"query":"What is this document about?"}'
# → {"jobId":"1","poll":"/query/1"}

# 3. poll for the answer
curl http://localhost:8000/query/1
# → {"status":"completed","result":{"answer":"...","sources":[...]}}
```

---

## API reference

### `GET /health`
```json
{ "status": "ok" }
```

### `POST /index`
`multipart/form-data`, field name **`file`**. PDF only, max 25 MB.

**202 Accepted**
```json
{
  "message": "File uploaded and queued for indexing",
  "jobId": "1",
  "file": { "originalName": "notes.pdf", "storedAs": "1753...-uuid.pdf", "size": 184320 }
}
```
**400** — no file / non-PDF / over 25 MB · **500** — could not reach Redis.

### `POST /query`
```json
{ "query": "How does reciprocal rank fusion work?" }
```
**202 Accepted**
```json
{ "message": "Query queued", "jobId": "7", "poll": "/query/7" }
```
**400** — missing or empty `query` string.

### `GET /query/:id`
Poll until `status` is `completed` or `failed`.

```json
{
  "jobId": "7",
  "status": "completed",
  "result": {
    "query": "How does reciprocal rank fusion work?",
    "queries": {
      "original":   "How does reciprocal rank fusion work?",
      "rewritten":  "How does the Reciprocal Rank Fusion algorithm combine ranked lists?",
      "stepBack":   "What are the common techniques for merging search result rankings?",
      "hyde":       "Reciprocal Rank Fusion assigns each document a score of 1/(k+rank) ...",
      "subQueries": ["What is the RRF formula?", "Why use rank instead of score?", "..."]
    },
    "answer": "RRF combines several ranked lists by ...",
    "sources": [
      {
        "text": "...",
        "source": "notes.pdf",
        "chunkIndex": 12,
        "score": 0.83,
        "rrfScore": 0.0491,
        "matchedBy": ["rewritten", "hyde", "subQuery2"]
      }
    ]
  }
}
```

`queries` shows every variant the retriever searched with, and `matchedBy` shows which of those
variants surfaced each chunk — both are there to let you debug retrieval quality.
Intermediate states: `waiting`, `active`, `delayed`, `paused`.
Failed jobs return **200** with `{ "status": "failed", "error": "..." }`.
Unknown id → **404**. Completed query jobs are kept for **1 hour**.

---

## Configuration

All values live in `.env`, read once in [src/config.js](src/config.js).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8000` | Express port |
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | BullMQ connection |
| `QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant REST endpoint |
| `QDRANT_COLLECTION` | `documents` | Collection name |
| `OPENAI_API_KEY` | — | **Required** |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `EMBEDDING_DIMENSIONS` | `1536` | **Must match the model** and the existing collection |
| `CHAT_MODEL` | `gpt-4o-mini` | Used for rewriting, HyDE and the final answer |
| `CHUNK_SIZE` | `1000` | Characters per chunk |
| `CHUNK_OVERLAP` | `200` | Characters shared between neighbouring chunks |
| `RETRIEVAL_TOP_K` | `4` | Candidates fetched from Qdrant **per query variant** |
| `RRF_K` | `60` | RRF damping constant — higher = flatter rank weighting |
| `RETRIEVAL_FINAL_K` | `5` | Chunks kept after fusion |

> ⚠️ Changing `EMBEDDING_MODEL` changes the vector size. Qdrant collections are fixed-size, so you
> must also change `EMBEDDING_DIMENSIONS` **and** drop/recreate the collection (or use a new
> `QDRANT_COLLECTION` name) — otherwise upserts fail with a dimension mismatch.

---

## Project structure

```
advance-rag/
├── docker-compose.yml    Qdrant (6333/6334) + Redis (6379), with named volumes
├── .env                  your secrets — git-ignored
├── .env.example          template to copy
├── uploads/              PDFs saved by multer — git-ignored, created at boot
└── src/
    ├── config.js         reads .env, exports `config` + queue names
    ├── index.js          Express app: /health, /index, /query, /query/:id
    ├── queue.js          BullMQ Queue instances + enqueue helpers (retry policy)
    ├── worker.js         two Workers: indexing (concurrency 2), query (concurrency 4)
    ├── indexer.js        chunkText() + indexPdf() — the whole indexing pipeline
    ├── retriever.js      queryRewriting, hydeDocument, RRF, retrieveChunks, answerQuery
    ├── openai.js         shared OpenAI client, embedText / embedTexts (batched)
    └── qdrant.js         Qdrant client + ensureCollection() (409-safe)
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:6379` | Redis not running → `npm run services:up` |
| `ECONNREFUSED 127.0.0.1:6333` | Qdrant not running → same |
| `401 Incorrect API key provided` | `OPENAI_API_KEY` missing or still `sk-replace-me` in `.env` |
| Job stays `waiting` forever | The worker process isn't running → `npm run worker` |
| `Vector dimension error` on upsert | `EMBEDDING_DIMENSIONS` ≠ the collection's size → recreate the collection or use a new name |
| `Only PDF files are allowed` | The upload isn't `application/pdf`, or the form field isn't named `file` |
| `chunks: 0, "No extractable text found"` | Scanned/image-only PDF — `pdf-parse` needs a text layer; you'd need OCR |
| Answer is "I don't know" | Nothing indexed yet, or `RETRIEVAL_TOP_K` too small — check the Qdrant dashboard for point count |

**No Docker?** Run the services natively instead:
```bash
sudo apt install -y redis-server && sudo systemctl enable --now redis-server
# Qdrant: download a release binary from https://github.com/qdrant/qdrant/releases
```

---

## Next steps

Natural extensions from here:
- **Reranking** — a cross-encoder pass over the fused chunks before generation
- **Metadata filters** — restrict search to one `source` PDF via Qdrant payload filters
- **Streaming answers** — SSE instead of job polling
- **Delete/re-index** — currently uploading the same PDF twice duplicates every chunk
