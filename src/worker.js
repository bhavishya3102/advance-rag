import { Worker, UnrecoverableError } from "bullmq";
import { connection } from "./queue.js";
import { INDEXING_QUEUE, QUERY_QUEUE } from "./config.js";
import { indexDocument, UnprocessableDocumentError } from "./indexer.js";
import { answerQuery } from "./retriever.js";

// Worker that consumes indexing jobs enqueued by the /index route and runs the
// pipeline: parse document -> chunk -> embed (OpenAI) -> upsert into Qdrant.
const indexingWorker = new Worker(
  INDEXING_QUEUE,
  async (job) => {
    console.log(`📥 Indexing job ${job.id}: ${job.data.originalName}`);

    try {
      const result = await indexDocument({
        filePath: job.data.filePath,
        originalName: job.data.originalName,
        docId: job.data.docId,
      });

      console.log(`   → ${result.chunks} chunk(s) indexed`);
      return result;
    } catch (err) {
      // A bad file will never succeed — fail now instead of burning 3 attempts.
      if (err instanceof UnprocessableDocumentError) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  },
  { connection, concurrency: 2 }
);

// Worker that consumes query jobs enqueued by the /query route and runs the
// RAG pipeline: embed query -> search Qdrant -> generate an answer.
const queryWorker = new Worker(
  QUERY_QUEUE,
  async (job) => {
    console.log(`🔎 Query job ${job.id}: ${JSON.stringify(job.data.query)}`);
    const result = await answerQuery(job.data.query);
    console.log(`   → answered using ${result.sources.length} chunk(s)`);
    return result;
  },
  { connection, concurrency: 4 }
);

for (const [name, worker] of [
  ["indexing", indexingWorker],
  ["query", queryWorker],
]) {
  worker.on("completed", (job) => console.log(`✅ [${name}] job ${job.id} completed`));
  worker.on("failed", (job, err) => console.error(`❌ [${name}] job ${job?.id} failed:`, err.message));
}

console.log("👷 Workers started (indexing + query). Waiting for jobs...");

// Graceful shutdown: let in-flight jobs finish so they aren't left "active"
// and stalled in Redis.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — finishing in-flight jobs...`);
    await Promise.all([indexingWorker.close(), queryWorker.close()]);
    process.exit(0);
  });
}
