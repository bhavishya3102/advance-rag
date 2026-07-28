

# Qdrant UI--- to show vectore database tables -- chunks

1. Dashboard (GUI)

http://localhost:6333/dashboard
Browser me kholo → Collections tab. Wahan documents dikhega, uspar click karke points browse kar sakte ho, payload (text, source, chunkIndex) dekh sakte ho, aur search bhi try kar sakte ho.


# Pipeline Walkthrough — One Real Question, Every Stage


This document follows **one actual run** of the pipeline from end to end. Every number, ranking and
piece of text below was captured from a real execution against a live Qdrant and the real OpenAI
API — nothing here is illustrative or made up. Reproduction steps are at the bottom.


**The document indexed:** a 6-section fictional "Zephyrite Protocol Handbook" (~3,500 characters).
Fictional on purpose — the model has no prior knowledge of Zephyrite, so any correct answer *must*
have come from retrieval, not from the model's memory.

**The question asked:**

```
why does zephyrite lose data when a node crashes and how do i fix it
```

Note the missing punctuation and the two-part structure. Both matter later.

---

## The whole run at a glance

```
  QUESTION
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 1  Query expansion            2 LLM calls, parallel       │
│          1 question  ──►  6 search variants            3,930 ms │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 2  Embedding                  1 batched API call          │
│          6 texts  ──►  6 × 1536-dim vectors              481 ms │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 3  Vector search              6 searches, parallel        │
│          6 vectors  ──►  6 ranked lists × 4 hits = 24     32 ms │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 4  Reciprocal Rank Fusion     pure arithmetic, no API     │
│          24 hits  ──►  5 unique  ──►  top 5              <1 ms │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│ STAGE 5  Generation                 1 LLM call                  │
│          5 chunks (4,519 chars)  ──►  answer           2,454 ms │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
  ANSWER                                    total ≈ 6.9 seconds
```

Everything above happens **inside the worker process**, after the HTTP request has already returned
`202 Accepted`. The client polls `GET /api/query/:id` for the result.

---

## Stage 0 — Indexing (this ran earlier, once)

Before any question can be asked, the PDF has to become vectors.

```
handbook.pdf
     │
     ├─ pdf-parse ────────────► raw text (~3,500 chars)
     │
     ├─ chunkText() ──────────► 5 chunks, 1000 chars each, 200 overlap
     │
     ├─ embedTexts(5) ────────► 5 × 1536-dim vectors   (1 batched call)
     │
     └─ qdrant.upsert() ──────► collection "documents", 5 points
```

The 5 chunks that actually landed in Qdrant:

| # | Length | First words |
|---|---|---|
| 0 | 1000 | `1. Overview Zephyrite is a distributed message bus designed for low-latency…` |
| 1 | 998 | `ts client identifier and the protocol version it speaks. The broker replies…` |
| 2 | 996 | `nsidered committed and the producer receives a confirmation. If the quorum…` |
| 3 | 998 | `fully replicated, which is why a lagging replica can cause disk usage to grow…` |
| 4 | 304 | `licensing The maintainer of the Zephyrite project is Ravindra Kulkarni…` |

### What the overlap looks like

Chunk 1 begins with `ts client identifier` — a fragment of the word *its*. That is not a bug in the
output, it is the overlap working:

```
        ┌──────────────── chunk 0 (chars 0…1000) ────────────────┐
text ───┤                                              ┌─────────┼──────── chunk 1 (chars 800…1798) ────┐
        └──────────────────────────────────────────────┼─────────┘                                      │
                                                       └──── these 200 chars appear in BOTH chunks ─────┘
```

`chunkText()` snaps the **end** of a chunk to a space so words aren't split, then steps back by
`CHUNK_OVERLAP` (200) to start the next one. That step-back is *not* snapped to a space, which is
why chunk 1 opens mid-word. Harmless for embeddings — the other 998 characters carry the meaning —
but worth knowing when you read the raw payloads.

Why overlap at all? Because a sentence that explains the crash-recovery command could otherwise be
cut in half by a chunk boundary, leaving neither chunk able to answer the question. With overlap,
every sentence appears whole in at least one chunk.

---

## Stage 1 — Query expansion (1 question → 6 variants)

Two LLM calls fire **in parallel** (`Promise.all`), which is why this stage costs 3,930 ms instead
of the sum of both.

```
                    "why does zephyrite lose data when a node crashes and how do i fix it"
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
        queryRewriting()                                hydeDocument()
        gpt-4o-mini, strict JSON schema                 gpt-4o-mini, free text
        temperature 0.2                                 temperature 0.3
                    │                                           │
        ┌───────────┼───────────┐                               │
        ▼           ▼           ▼                               ▼
    rewritten   stepBack   subQueries[3]                       hyde
```

### 1a. `rewritten`

> **Why does Zephyrite lose data when a node crashes, and how can I fix this issue?**

Capitalisation fixed, comma and question mark added, made a complete sentence. A small change here
because the input was only lightly malformed — on a typo-heavy query (`"wht is the handshak
timeout"`) this is where the real repair happens.

### 1b. `stepBack`

> **What are the common causes of data loss in distributed systems like Zephyrite?**

This deliberately *widens* the question. It drops "node crashes" and asks about the general topic.
The point is to retrieve background/conceptual chunks that never use the user's exact words.

### 1c. `subQueries` — the two-part question gets split

> 1. What mechanisms does Zephyrite use to handle node crashes?
> 2. What are the best practices for data recovery in Zephyrite?
> 3. How can I implement redundancy to prevent data loss in Zephyrite?

The original asked **two things** — *why does it happen* and *how do I fix it*. A single embedding of
that sentence is a blend of both halves and sits at neither. Sub-queries give each half its own
search.

### 1d. `hyde` — the hypothetical answer

> Zephyrite, a distributed data storage system, may lose data during a node crash due to its reliance
> on a consensus mechanism that requires multiple nodes to agree on the state of the data. If a node
> fails before it can replicate or synchronize its data with others, that information may be lost. To
> mitigate this issue, implement regular data backups, increase the replication factor… employing a
> distributed logging system can help in recovering lost data by replaying logs from surviving nodes.

**This passage is largely wrong.** The real handbook says nothing about backups or replication
factors; the actual cause is a damaged write-ahead-log tail. And that is completely fine — read on.

```
   Why HyDE works, in one picture:

   vector space
   ─────────────────────────────────────────────────────────
        ?  questions live over here
        ?  ("why does X fail?")
                                  ▪ ▪ ▪  documents live over there
                                  ▪ ▪ ▪  ("X fails when the log tail
                                  ▪ ▪ ▪   is damaged by an unclean…")

   Embedding the question searches from the "?" region.
   Embedding a fake ANSWER searches from the "▪" region —
   same neighbourhood as the real documents.
```

HyDE's text is used **only to produce a search vector**. It never enters the final prompt, so its
invented facts cannot reach the user. Being wrong about specifics but right about *shape and
vocabulary* ("node crash", "replaying logs", "recover") is enough to land in the right region.

---

## Stage 2 — Embedding (6 texts → 6 vectors)

```
6 variant texts ──► embedTexts() ──► ONE API call ──► 6 × 1536 floats
                    text-embedding-3-small                    481 ms
```

All six go in a single batched request rather than six separate ones. `embedTexts()` batches in
groups of 100, so even a 300-chunk PDF is only three calls.

---

## Stage 3 — Six searches, run in parallel

Each vector gets its own Qdrant search with `limit = RETRIEVAL_TOP_K = 4`.

```
rewritten  ──►┐
stepBack   ──►│
hyde       ──►├──► Promise.all( 6 × qdrant.search ) ──► 6 ranked lists
subQuery1  ──►│         cosine similarity                 4 hits each
subQuery2  ──►│                                           = 24 hits
subQuery3  ──►┘                                              32 ms
```

The full result — which chunk each variant ranked where, with its raw cosine score:

| Variant | rank 1 | rank 2 | rank 3 | rank 4 |
|---|---|---|---|---|
| `rewritten` | **c3** 0.7244 | c2 0.6634 | c0 0.5338 | c1 0.4517 |
| `stepBack` | **c3** 0.6911 | c2 0.6316 | c0 0.6005 | c1 0.4782 |
| `hyde` | **c3** 0.7173 | c2 0.7032 | c0 0.5667 | c1 0.4741 |
| `subQuery1` | **c3** 0.6855 | c2 0.6631 | c0 0.6128 | c1 0.5148 |
| `subQuery2` | **c3** 0.6878 | c2 0.5893 | c0 0.5268 | **c4** 0.4805 |
| `subQuery3` | **c3** 0.6724 | c2 0.6300 | c0 0.5812 | c1 0.4831 |

Two things to read out of this table:

1. **Chunk 3 won every single list.** Chunk 3 is the crash-recovery section — it contains
   `zephctl repair --wal zeph-wal`. Six independent formulations of the question all agreed. That
   is a strong signal, and it is exactly the signal RRF is built to reward.
2. **`subQuery2` disagreed at rank 4.** Every other variant put chunk 1 (the handshake section)
   fourth; `subQuery2` ("best practices for data recovery") pulled chunk 4 (licensing/maintainer)
   instead. One variant found something the other five never saw — this is the coverage that
   multi-query retrieval buys you.

---

## Stage 4 — Reciprocal Rank Fusion

Now six ranked lists must become one. RRF ignores the raw cosine scores entirely and uses only
**rank position**:

```
                              1
     score(chunk)  =  Σ  ───────────        over every list the chunk appears in
                    lists   k + rank         k = RRF_K = 60
```

### Why throw the scores away?

Cosine scores from different query vectors aren't comparable. `hyde` scored 0.7032 on chunk 2 while
`subQuery2` scored 0.5893 on the *same chunk* — the number reflects how the variant was phrased as
much as how relevant the chunk is. Rank ("this list's 2nd best") survives that; the raw number
doesn't. The `+ k` term flattens the curve, so rank 1 (1/61) is only slightly better than rank 4
(1/64) — a chunk wins by appearing **often**, not by topping one list.

### The arithmetic, worked out

| Chunk | Appeared in | At ranks | Sum | RRF score |
|---|---|---|---|---|
| **c3** | 6 of 6 lists | 1,1,1,1,1,1 | 6 × 1/61 | **0.09836** |
| **c2** | 6 of 6 lists | 2,2,2,2,2,2 | 6 × 1/62 | **0.09677** |
| **c0** | 6 of 6 lists | 3,3,3,3,3,3 | 6 × 1/63 | **0.09524** |
| **c1** | 5 of 6 lists | 4,4,4,4,4 | 5 × 1/64 | **0.07813** |
| **c4** | 1 of 6 lists | 4 | 1 × 1/64 | **0.01563** |

Look at the bottom two rows — this is the whole idea of RRF in two lines. Chunk 1 and chunk 4 were
both ranked **4th** by the variants that found them. Identical rank, identical per-hit contribution
of 1/64. But chunk 1 was found by five variants and chunk 4 by one, so chunk 1 scores **5× higher**.
Consensus, not any single opinion, decides the order.

```
   24 hits (with duplicates)
        │
        ├─ group by chunk id, sum 1/(60+rank)
        ▼
   5 unique chunks, re-ranked
        │
        ├─ slice(0, RETRIEVAL_FINAL_K = 5)
        ▼
   5 chunks kept  ──►  4,519 characters of context
```

### So which chunks actually reached the model?

Reading it straight off the Stage 3 table: six lists × four hits = **24 hits**, but only **five
distinct chunks** (c0, c1, c2, c3, c4). The same chunks keep reappearing across variants — that
repetition *is* the signal RRF measures. After deduping and sorting by fused score the order is:

```
   c3  →  c2  →  c0  →  c1  →  c4
 0.0984  0.0968  0.0950  0.0781  0.0156
```

`RETRIEVAL_FINAL_K` is 5 and there were exactly 5 candidates, so **all five were kept**.

**But look at how c4 got in.** Only `subQuery2` ever found it, at rank 4. Its fused score is
**five times lower** than c1's (0.0156 vs 0.0781). It made the cut because there was nothing else
competing for the fifth slot — not because it earned it.

On a real corpus that changes completely. With 600 chunks in the index the six variants would surface
perhaps 20 distinct candidates, and `slice(0, 5)` would drop c4 long before it reached the prompt.
That is exactly RRF's job: keep a chunk that only one variant liked *below* the chunks several
variants agreed on.

You can see this in the UI — c4's row in the Retrieval Trace shows a single `subQuery2` chip and a
visibly stubby bar, while the rows above it carry all six chips.

---

## Stage 5 — Generation

The kept chunks are formatted and sent with a deliberately strict system prompt:

```
System: "Answer the user's question using ONLY the provided context.
         If the answer is not contained in the context, say you don't know. Be concise."

User:    Context:
         [Chunk 1] (source: zephyrite-handbook.pdf)
         fully replicated, which is why a lagging replica…
         [Chunk 2] …
         … 4,519 characters total …

         Question: why does zephyrite lose data when a node crashes and how do i fix it
```

### Wait — isn't 4,519 characters the *entire document*?

Yes, and that is worth being precise about, because it looks like retrieval achieved nothing.

The pipeline sends **only the kept chunks** — never the source file. It just happens that this
document contains exactly 5 chunks and `RETRIEVAL_FINAL_K` is exactly 5, so "the top 5" and "all of
it" are the same set here. The number checks out to the character:

```
  chunk text     1000 + 998 + 996 + 998 + 304        = 4,296
  5 × header     "[Chunk 1] (source: zephyrite-handbook.pdf)\n"
                 43 chars each                       =   215
  4 × separator  "\n\n"                              =     8
                                                       ───────
                                               total   = 4,519   ← the figure above
```

Nothing extra is smuggled in: the context is the five chunk bodies plus their labels.

What the same code does on a document that isn't a toy:

| | This test document | A 200-page PDF |
|---|---|---|
| Chunks in the index | 5 | ~600 |
| Characters in the index | ~4,300 | ~600,000 |
| Characters sent to the LLM | 4,519 | ~5,000 |
| **Reduction** | **0%** | **~99%** |

The prompt size is governed by `RETRIEVAL_FINAL_K`, not by the size of the corpus — five chunks cost
the same whether the index holds 5 documents or 5,000. That is the whole economic point of
retrieval: prompt cost stays flat while the knowledge base grows.

If you want a smaller context, lower `RETRIEVAL_FINAL_K` in `.env`. Lower it too far and multi-part
questions start losing one of their halves — this question needed both the crash-recovery chunk
(c3) *and* the surrounding context to answer fully.

**The answer produced:**

> Zephyrite loses data when a node crashes because the message may have been written to the log, but
> the log tail could be damaged by an unclean shutdown, leading to apparent data loss. To fix it, you
> can run the command `zephctl repair --wal zeph-wal`, which truncates the log to the last valid
> record and re-syncs the missing messages from a healthy replica.

Both halves of the two-part question answered, both correct against the source document, and the
exact command recovered. Cost: **1,009 prompt tokens + 82 completion tokens**.

Compare this against Stage 1d — the HyDE passage confidently claimed the fix was "regular data
backups" and "increase the replication factor". None of that invention survived into the answer,
because HyDE only ever steered the search.

---

## Where the time went

| Stage | Time | Share |
|---|---|---|
| Query expansion (2 LLM calls, parallel) | 3,930 ms | 57% |
| Embedding (1 batched call) | 481 ms | 7% |
| Vector search (6, parallel) | **32 ms** | 0.5% |
| RRF fusion | <1 ms | ~0% |
| Generation (1 LLM call) | 2,454 ms | 36% |
| **Total** | **≈ 6.9 s** | |

The lesson: **the vector database is not the bottleneck.** Six searches cost 32 ms combined. Over
99% of the wall-clock time is spent waiting on OpenAI. If you ever want to make this faster, cut LLM
round-trips — don't optimise Qdrant.

The single most expensive item is Stage 1, and it is *optional*. Skipping expansion would drop
~4 seconds and 2 LLM calls per query.

---

## Honest comparison: did the advanced pipeline actually help here?

The same trace also ran the **old** single-vector search — embed the raw question, one Qdrant
search — for comparison:

| | Basic (1 vector) | Advanced (6 vectors + RRF) |
|---|---|---|
| Ranking | c3, c2, c0, c1 | c3, c2, c0, c1, **c4** |
| Chunks retrieved | 4 | 5 |
| LLM calls | 1 | 3 |
| Wall clock | ≈ 2.7 s | ≈ 6.9 s |

**The top 4 are identical.** On this document the advanced pipeline produced the same ordering as
the basic one, plus one extra chunk. It cost 2 extra LLM calls and ~4 extra seconds to get there.

That is a real result and it should not be hidden. Here is why it happened, and it is entirely about
the size of the test corpus:

- The handbook has only **5 chunks total**. `RETRIEVAL_FINAL_K` is 5. The pipeline therefore
  retrieved **the entire document** — there was nothing to discriminate between.
- With 5 chunks, all six variants were fishing in the same tiny pond, so they naturally agreed.
  RRF's job is to resolve *disagreement*, and there was almost none to resolve.
- The one place a difference did appear — `subQuery2` surfacing chunk 4 — is a miniature version of
  the real benefit.

### What this example does NOT prove

It does not prove the advanced pipeline retrieves better than the basic one. Demonstrating that
needs a corpus large enough that the top-4 is a genuine choice — hundreds or thousands of chunks
across many documents, where variants disagree and consensus carries information.

What this example **does** prove is that every stage executes correctly: expansion produces sensible
variants, all six searches run, RRF arithmetic is exact, HyDE's hallucinations stay out of the
answer, and the final answer is grounded in the source.

### So when is the expansion worth paying for?

| Situation | Worth it? |
|---|---|
| Small corpus (a handful of chunks) | ✗ — everything is retrieved anyway |
| Simple keyword lookup ("what is the timeout?") | ✗ — direct match already works |
| Large corpus, vague or conversational query | ✓ — expansion finds the right region |
| Multi-part question | ✓ — sub-queries retrieve each part separately |
| Query vocabulary differs from document vocabulary | ✓ — this is HyDE's core case |
| Latency-sensitive or high-volume | ✗ — 3× the LLM cost per query |

---

## Reproducing this

The quickest way is the UI — `npm run ui`, drop the file on the left rail, ask, then expand the
**Retrieval trace** under the answer. It shows the same six variants and per-chunk scores as the
tables above. Over HTTP:

```bash
npm run services:up      # Qdrant on 6333 (Redis runs natively on 6379)
npm run dev              # API   on 8000
npm run worker           # worker — the pipeline runs HERE

# index a document
curl -F "file=@handbook.pdf" http://localhost:8000/api/index

# ask, then poll
curl -X POST http://localhost:8000/api/query -H "Content-Type: application/json" \
     -d '{"query":"why does zephyrite lose data when a node crashes and how do i fix it"}'
curl http://localhost:8000/api/query/1
```

The `/api/query/:id` response carries the pipeline's own trace: `queries` shows all six variants that
were searched, and each source's `matchedBy` lists which variants found it — the same data the
tables above are built from.



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

**Reading the numbers in a response:**

| Field | Meaning |
|---|---|
| `score` | Best raw cosine similarity across variants. Comparable *within* one list only |
| `rrfScore` | Fused rank score. **This is what decided the ordering** |
| `matchedBy` | Which variants surfaced this chunk. Length 1 = only one variant found it — treat with suspicion; length 6 = unanimous |

The code itself: [src/retriever.js](src/retriever.js) (stages 1–5), [src/indexer.js](src/indexer.js)
(stage 0). See [README.md](README.md) for setup and the API reference.
