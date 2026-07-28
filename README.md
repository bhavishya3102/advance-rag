# Reading Room — Advanced RAG over your own documents

An **Advanced RAG (Retrieval Augmented Generation)** pipeline in Node.js, with a React UI.

Add a PDF or Markdown file → it gets parsed, chunked, embedded and stored in a vector DB
(asynchronously, via a queue). Ask a question → the query is expanded into six variants (rewriting,
step-back, HyDE, sub-queries), each searches the vector DB, the ranked lists are fused with
**Reciprocal Rank Fusion**, and the top chunks are handed to the LLM to write a grounded answer.

Nothing blocks the HTTP request: heavy work (parsing, embeddings, LLM calls) runs in a **separate
worker process**, so the API stays fast and jobs can retry on failure.

The UI doesn't hide any of that. Every answer carries a **retrieval trace** — the six query variants
that were searched, which variant found which chunk, and the fused rank score that decided the
order.

> 📘 **[PIPELINE-EXAMPLE.md](PIPELINE-EXAMPLE.md)** — one real question traced through every stage,
> with the actual query variants, per-variant rankings, RRF arithmetic and timings from a live run.
> Start there if you want to understand *how* it works rather than how to run it.

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

```
                        ┌──────────────────────────────┐
                        │   React UI  (web/)            │
                        │   Vite dev :5173, or built    │
                        │   and served by Express       │
                        └───────────┬──────────────────┘
                                    │ /api/*
                                    ▼
                        ┌──────────────────────────────┐
   POST /api/index    ──►│                              │
   POST /api/query    ──►│   Express API  (src/index.js)│
   GET  /api/query/:id──►│      port 8000               │
   GET  /api/sources  ──►│                              │
                        └───────────┬──────────────────┘
                                    │ add job
                                    ▼
                        ┌──────────────────────────────┐
                        │   Redis  (BullMQ queues)      │  native service :6379
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

### 1. Indexing flow (document → vectors)

```
POST /api/index  (multipart form-data, field: file)
      │
      ├─ multer: validate extension (.pdf .md .markdown .txt), max 25 MB
      ├─ save to  uploads/<timestamp>-<uuid><ext>
      ├─ enqueueIndexingJob({ docId, filePath, originalName, size })  → queue "file-indexing"
      └─ respond 202 { jobId, docId, file }                     ← request ends here
                    │
                    ▼  (worker process picks the job up)
      indexDocument()  in src/indexer.js
      │
      ├─ 1. ensureCollection()      create Qdrant collection if missing
      │                             (vector size = EMBEDDING_DIMENSIONS, distance = Cosine)
      │                             + payload index on docId, for filtered delete
      ├─ 2. readDocumentText()      .pdf → pdf-parse · .md/.txt → read as UTF-8
      ├─ 3. chunkText()             collapse whitespace, slice into ~1000-char chunks
      │                             with 200-char overlap, cutting on word boundaries
      ├─ 4. embedTexts(chunks)      OpenAI embeddings, batched 100 at a time
      ├─ 5. build points            { id: uuid, vector, payload: { text, source, docId,
      │                               kind, filePath, chunkIndex, indexedAt } }
      └─ 6. qdrant.upsert()         wait: true → written & searchable
      →  returns { chunks: N, collection, kind, indexedAt }
```

Job options: `attempts: 3`, exponential backoff starting at 2s. A file that can never succeed —
unsupported type, or no extractable text — throws `UnprocessableDocumentError`, which the worker
converts to a BullMQ `UnrecoverableError` so it fails immediately instead of retrying three times.

Every chunk of a document shares one `docId`, so `DELETE /api/sources/:docId` removes the whole
document with a single filtered delete even if two uploads share a filename.

**Why overlap?** A chunk boundary can cut a sentence in half and destroy its meaning. A 200-char
overlap means every sentence appears whole in at least one chunk.

### 2. Query flow (question → answer)

```
POST /api/query  { "query": "..." }
      │
      ├─ enqueueQueryJob({ query })   → queue "query"
      └─ respond 202 { jobId, poll: "/api/query/<id>" }   ← request ends here

GET /api/query/:id → { status: "waiting" | "active" | "completed" | "failed", result? }
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
| Docker + Docker Compose | any recent | Runs Qdrant |
| Redis | 6+ | Runs as a **native system service**, not in Docker — see below |
| OpenAI API key | — | Used for embeddings **and** chat |

> **Why is Redis not in `docker-compose.yml`?** This machine already runs
> `redis-server` as a systemd service on port 6379, so a container would fail to bind that port
> (`address already in use`). The app just connects to `127.0.0.1:6379` either way. Check it with:
> ```bash
> systemctl status redis-server     # should be active
> redis-cli ping                    # → PONG
> ```
> On a machine *without* native Redis, add the service back to `docker-compose.yml`:
> ```yaml
>   redis:
>     image: redis:7-alpine
>     ports: ["6379:6379"]
> ```

---

## Setup

```bash
# 1. backend dependencies
npm install

# 2. frontend dependencies
npm run ui:install           # npm --prefix web install

# 3. create your env file
cp .env.example .env

# 4. put your real key in .env
#    OPENAI_API_KEY=sk-...
```

`.env`, `uploads/` and `web/dist/` are git-ignored — the key never gets committed.

---

## Running the project

### Development (hot reload)

Four terminals:

```bash
# ── 1: infrastructure (Qdrant) ──
npm run services:up          # docker compose up -d
# Qdrant dashboard: http://localhost:6333/dashboard
# Redis is already running as a system service — nothing to start.

# ── 2: API server ──
npm run dev                  # node --watch src/index.js
# 🚀 API listening on http://localhost:8000

# ── 3: worker ──  (the pipeline actually runs HERE)
npm run worker
# 👷 Workers started (indexing + query). Waiting for jobs...

# ── 4: UI ──
npm run ui                   # vite dev server
# ➜  http://localhost:5173
```

Open **http://localhost:5173**. Vite proxies `/api` to port 8000, so the browser only ever talks to
one origin and CORS never comes up.

### Production-ish (one server)

```bash
npm run ui:build             # emits web/dist
npm start                    # Express serves the built UI *and* the API
npm run worker               # in another terminal
```

Open **http://localhost:8000**. Express serves `web/dist` when it exists, with an SPA fallback for
any non-`/api` route.

Stop the containers with `npm run services:down`.

### Watching the queues

Two dashboards, both read-only views onto what the pipeline is actually doing:

| | URL | Shows |
|---|---|---|
| **Bull Board** | http://localhost:8000/admin/queues | Both BullMQ queues — job counts by state, and per job its `data`, `returnvalue`, failure reason + stack, timings, and retry/clean buttons |
| **Qdrant** | http://localhost:6333/dashboard | The `documents` collection — point count, vector config, and the stored chunks with their payloads |

Bull Board is the fastest way to answer "why didn't my PDF index?" — open the **Failed** tab and read
the error. A common one is `No extractable text found`, which means the PDF is scanned/image-only
and has no text layer for `pdf-parse` to read; that needs OCR, which this pipeline doesn't do.

> ⚠️ Bull Board has **no authentication**. It exposes job payloads and lets anyone retry or delete
> jobs. Fine on localhost; put it behind a proxy or drop the route before exposing this server.
> The path is configurable with `QUEUE_DASHBOARD_PATH`.

Same information from the terminal, if you prefer:

```bash
redis-cli LLEN  bull:file-indexing:wait        # queued
redis-cli ZCARD bull:file-indexing:failed      # failures
redis-cli ZRANGE bull:file-indexing:failed 0 -1        # their ids
redis-cli HGET  bull:file-indexing:14 failedReason     # why one failed
redis-cli XREVRANGE bull:query:events + - COUNT 10     # recent state changes
```

### Using the UI

- **Add a source** — drag files onto the left rail, or click it to browse. PDF, Markdown and plain
  text, up to 25 MB. You'll see upload progress, then an indeterminate bar while the worker chunks
  and embeds it. Failures stay on screen with the reason.
- **Ask** — `Enter` sends, `Shift`+`Enter` adds a newline. `Stop` cancels an in-flight question.
- **Retrieval trace** — under every answer. Expand it to see all six query variants that were
  searched, and for each retrieved chunk its RRF score, raw cosine score, and the `matchedBy` chips
  showing which variants found it.
- **Remove a source** — hover an entry in the rail and confirm. This deletes its chunks from Qdrant
  and the uploaded file from disk.

### End-to-end smoke test

```bash
# health
curl http://localhost:8000/api/health
# → {"status":"ok"}

# 1. index a PDF
curl -F "file=@/path/to/your.pdf" http://localhost:8000/api/index
# → {"message":"File uploaded and queued for indexing","jobId":"1", ...}
#   watch Terminal 3:  📥 Indexing job 1 → 42 chunk(s) indexed  ✅

# 2. ask a question
curl -X POST http://localhost:8000/api/query \
     -H "Content-Type: application/json" \
     -d '{"query":"What is this document about?"}'
# → {"jobId":"1","poll":"/api/query/1"}

# 3. poll for the answer
curl http://localhost:8000/api/query/1
# → {"status":"completed","result":{"answer":"...","sources":[...]}}
```

---

## API reference

### `GET /api/health`
```json
{ "status": "ok" }
```

### `GET /api/config`
Upload constraints, so the UI and the server can never disagree about them.
```json
{ "maxBytes": 26214400, "extensions": [".pdf", ".md", ".markdown", ".txt"] }
```

### `POST /api/index`
`multipart/form-data`, field name **`file`**. `.pdf` `.md` `.markdown` `.txt`, max 25 MB, one file
per request.

**202 Accepted**
```json
{
  "jobId": "1",
  "docId": "e95a02f3-38b3-4695-8569-86362c2b240c",
  "file": { "name": "notes.pdf", "size": 184320 }
}
```
**400** — no file / unsupported type / over 25 MB · **500** — could not reach Redis.

### `GET /api/index/:id`
Poll an indexing job. Same shape as `GET /api/query/:id`.
```json
{
  "jobId": "1",
  "status": "completed",
  "result": { "chunks": 42, "collection": "documents", "kind": "PDF", "indexedAt": "2026-07-28T…" }
}
```

### `GET /api/sources`
The document library, aggregated from the chunks in Qdrant. Newest first; `[]` if nothing is indexed.
```json
{
  "sources": [
    {
      "docId": "e95a02f3-…",
      "name": "notes.pdf",
      "kind": "PDF",
      "chunks": 42,
      "indexedAt": "2026-07-28T10:37:16.680Z"
    }
  ]
}
```

### `DELETE /api/sources/:docId`
Removes every chunk of that document from Qdrant and deletes its uploaded file.
```json
{ "deleted": "e95a02f3-…" }
```
**404** — no such document.

### `POST /api/query`
```json
{ "query": "How does reciprocal rank fusion work?" }
```
**202 Accepted**
```json
{ "message": "Query queued", "jobId": "7", "poll": "/api/query/7" }
```
**400** — missing or empty `query` string.

### `GET /api/query/:id`
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
| `QUEUE_DASHBOARD_PATH` | `/admin/queues` | Where Bull Board mounts. No auth — localhost only |
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
├── docker-compose.yml    Qdrant only (6333/6334) — Redis runs natively on 6379
├── .env                  your secrets — git-ignored
├── .env.example          template to copy
├── uploads/              files saved by multer — git-ignored, created at boot
├── src/                  backend
│   ├── config.js         reads .env, exports `config` + queue names
│   ├── index.js          Express app: /api/* routes + serves web/dist
│   ├── queue.js          BullMQ Queue instances + enqueue helpers (retry policy)
│   ├── worker.js         two Workers: indexing (concurrency 2), query (concurrency 4)
│   ├── indexer.js        chunkText() + indexDocument() — the indexing pipeline
│   ├── retriever.js      queryRewriting, hydeDocument, RRF, retrieveChunks, answerQuery
│   ├── sources.js        document library: list/aggregate + delete by docId
│   ├── openai.js         shared OpenAI client, embedText / embedTexts (batched)
│   └── qdrant.js         Qdrant client + ensureCollection() (409-safe)
└── web/                  React frontend (Vite)
    ├── vite.config.js    dev server + /api proxy to :8000
    └── src/
        ├── api/client.js       fetch wrapper, upload with progress, bounded job polling
        ├── hooks/              useSources (library) · useConversation (chat)
        ├── lib/format.js       bytes / relative time / duration helpers
        ├── styles/tokens.css   design tokens, reset, atmosphere, reduced-motion
        └── components/         Header · ArchiveRail · Conversation · RetrievalTrace · Composer
```

### A note on CSS Modules and `@keyframes`

Each `*.module.css` declares the `@keyframes` it uses **locally**, and `tokens.css` deliberately
declares none. CSS Modules rewrite `animation-name` to a module-scoped identifier, so a module
referencing a keyframe defined in a global sheet resolves to a name that doesn't exist — the
animation silently never runs, and anything whose resting state depends on it (an element starting
at `opacity: 0`) stays invisible forever. Don't "DRY up" the keyframes into `tokens.css`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `permission denied ... /var/run/docker.sock` | Your shell doesn't have the `docker` group yet. `getent group docker` shows you're a member but `id -nG` doesn't → group membership only loads at **login**. Fully quit and reopen your terminal/VS Code, or for a one-off: `sg docker -c "docker compose up -d"` |
| `failed to bind host port 0.0.0.0:6379: address already in use` | Native `redis-server` already owns 6379. That's expected here — Redis was removed from `docker-compose.yml` on purpose |
| `ECONNREFUSED 127.0.0.1:6379` | Native Redis is down → `sudo systemctl start redis-server` |
| `ECONNREFUSED 127.0.0.1:6333` | Qdrant not running → `npm run services:up` |
| `401 Incorrect API key provided` | `OPENAI_API_KEY` missing or still `sk-replace-me` in `.env` |
| Job stays `waiting` forever | The worker process isn't running → `npm run worker` |
| `Vector dimension error` on upsert | `EMBEDDING_DIMENSIONS` ≠ the collection's size → recreate the collection or use a new name |
| `Only PDF files are allowed` | The upload isn't `application/pdf`, or the form field isn't named `file` |
| `chunks: 0, "No extractable text found"` | Scanned/image-only PDF — `pdf-parse` needs a text layer; you'd need OCR |
| Answer is "I don't know" | Nothing indexed yet, or `RETRIEVAL_TOP_K` too small — check the Qdrant dashboard for point count |

**No Docker?** Qdrant can also run natively — download a release binary from
[github.com/qdrant/qdrant/releases](https://github.com/qdrant/qdrant/releases). Redis already runs
natively here (`sudo apt install -y redis-server` if it's ever missing).

---

## Next steps

Natural extensions from here:
- **Reranking** — a cross-encoder pass over the fused chunks before generation
- **Metadata filters** — restrict search to one `source` PDF via Qdrant payload filters
- **Streaming answers** — SSE instead of job polling
- **Delete/re-index** — currently uploading the same PDF twice duplicates every chunk
