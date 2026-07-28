import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { config } from "./config.js";
import { SUPPORTED_EXTENSIONS } from "./indexer.js";
import { listSources, deleteSource } from "./sources.js";
import {
  enqueueIndexingJob,
  enqueueQueryJob,
  indexingQueue,
  queryQueue,
} from "./queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, "..", "uploads");
const clientDist = path.join(__dirname, "..", "web", "dist");

// Ensure the uploads directory exists.
fs.mkdirSync(uploadDir, { recursive: true });

// --- Multer: store uploads on disk under a unique, non-guessable name ---
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomUUID()}`;
    // path.extname on the *original* name only — never trust it as a path.
    cb(null, `${unique}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.upload.maxBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext in SUPPORTED_EXTENSIONS) return cb(null, true);
    cb(
      new multer.MulterError(
        "LIMIT_UNEXPECTED_FILE",
        `Unsupported file type "${ext || "unknown"}". Allowed: ${Object.keys(
          SUPPORTED_EXTENSIONS
        ).join(", ")}`
      )
    );
  },
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

/** Delete a temp upload we're not going to keep, without masking the real error. */
async function discardUpload(filePath) {
  if (!filePath) return;
  await fsp.unlink(filePath).catch(() => {});
}

/** Shared shape for polling an indexing or query job. */
async function readJobState(queue, id) {
  const job = await queue.getJob(id);
  if (!job) return null;

  const status = await job.getState();
  if (status === "completed") return { jobId: job.id, status, result: job.returnvalue };
  if (status === "failed") return { jobId: job.id, status, error: job.failedReason };
  return { jobId: job.id, status };
}

// ---------------------------------------------------------------- health ---

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// --------------------------------------------------------------- sources ---

/** Metadata the upload UI needs before it lets the user pick a file. */
app.get("/api/config", (_req, res) =>
  res.json({
    maxBytes: config.upload.maxBytes,
    extensions: Object.keys(SUPPORTED_EXTENSIONS),
  })
);

app.get("/api/sources", async (_req, res, next) => {
  try {
    res.json({ sources: await listSources() });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/sources/:docId", async (req, res, next) => {
  try {
    const removed = await deleteSource(req.params.docId);
    if (!removed) return res.status(404).json({ error: "Source not found" });
    res.json({ deleted: req.params.docId });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- indexing ---

app.post("/api/index", upload.single("file"), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded (field name: 'file')" });
  }

  try {
    const docId = crypto.randomUUID();
    const job = await enqueueIndexingJob({
      docId,
      filePath: req.file.path,
      originalName: req.file.originalname,
      size: req.file.size,
    });

    res.status(202).json({
      jobId: job.id,
      docId,
      file: { name: req.file.originalname, size: req.file.size },
    });
  } catch (err) {
    await discardUpload(req.file?.path);
    next(err);
  }
});

app.get("/api/index/:id", async (req, res, next) => {
  try {
    const state = await readJobState(indexingQueue, req.params.id);
    if (!state) return res.status(404).json({ error: "Job not found" });
    res.json(state);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- query ---

app.post("/api/query", async (req, res, next) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    return res.status(400).json({ error: "Body must include a non-empty 'query' string" });
  }
  if (query.length > config.query.maxChars) {
    return res
      .status(400)
      .json({ error: `Query is too long (max ${config.query.maxChars} characters)` });
  }

  try {
    const job = await enqueueQueryJob({ query });
    res.status(202).json({ jobId: job.id, poll: `/api/query/${job.id}` });
  } catch (err) {
    next(err);
  }
});

app.get("/api/query/:id", async (req, res, next) => {
  try {
    const state = await readJobState(queryQueue, req.params.id);
    if (!state) return res.status(404).json({ error: "Job not found" });
    res.json(state);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------ queue dashboard ---

// Bull Board: inspect both queues, drill into a job's data / result / stack
// trace, retry a failure, clean out old jobs.
//
// Mounted BEFORE the SPA catch-all below, which would otherwise swallow this
// path and serve index.html instead. It has no authentication, so keep it off
// a public port or put it behind a proxy.
const bullBoard = new ExpressAdapter();
bullBoard.setBasePath(config.queueDashboardPath);
createBullBoard({
  queues: [new BullMQAdapter(indexingQueue), new BullMQAdapter(queryQueue)],
  serverAdapter: bullBoard,
});
app.use(config.queueDashboardPath, bullBoard.getRouter());

// ------------------------------------------------------- static frontend ---

// Serve the built React app when it exists (npm run build in web/).
// In development the Vite dev server proxies /api here instead.
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/).*/, (_req, res) =>
    res.sendFile(path.join(clientDist, "index.html"))
  );
} else {
  app.get("/", (_req, res) =>
    res
      .status(200)
      .type("text/plain")
      .send("API is running. Build the UI with:  cd web && npm run build")
  );
}

// ---------------------------------------------------------- error handler ---

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `File is too large (max ${Math.round(config.upload.maxBytes / 1024 / 1024)} MB)`
        : err.field || err.message;
    discardUpload(req.file?.path);
    return res.status(400).json({ error: message });
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(config.port, () => {
  console.log(`🚀 API listening on http://localhost:${config.port}`);
  console.log(
    `📊 Queues      http://localhost:${config.port}${config.queueDashboardPath}`
  );
  if (!fs.existsSync(clientDist)) {
    console.log("   UI not built yet — run the Vite dev server in web/");
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal} received — closing server...`);
    server.close(() => process.exit(0));
  });
}
