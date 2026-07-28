import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
// Import the lib entry directly to avoid pdf-parse's debug-mode file read on import.
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { config } from "./config.js";
import { qdrant, ensureCollection } from "./qdrant.js";
import { embedTexts } from "./openai.js";

/**
 * Thrown when a document can never be indexed no matter how many times we try
 * (wrong file type, no extractable text). The worker turns this into a BullMQ
 * UnrecoverableError so the job fails immediately instead of retrying.
 */
export class UnprocessableDocumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnprocessableDocumentError";
  }
}

/** Extensions we can turn into text, and the label shown in the UI. */
export const SUPPORTED_EXTENSIONS = {
  ".pdf": "PDF",
  ".md": "Markdown",
  ".markdown": "Markdown",
  ".txt": "Text",
};

/** Read a PDF from disk and return its raw text. */
async function readPdfText(filePath) {
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

/**
 * Read a plain-text/Markdown file. Markdown syntax is left in place — the
 * embedding model handles it fine, and headings carry real meaning.
 */
async function readPlainText(filePath) {
  return fs.readFile(filePath, "utf8");
}

/** Dispatch on file extension. Throws for anything we can't parse. */
async function readDocumentText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return readPdfText(filePath);
  if (ext in SUPPORTED_EXTENSIONS) return readPlainText(filePath);
  throw new UnprocessableDocumentError(`Unsupported file type: ${ext || "(none)"}`);
}

/**
 * Split text into overlapping chunks (~chunkSize chars, chunkOverlap overlap),
 * breaking on whitespace boundaries where possible.
 */
export function chunkText(text, chunkSize = config.chunking.chunkSize, overlap = config.chunking.chunkOverlap) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);

    // Try to end on a space so we don't cut words in half.
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(" ", end);
      if (lastSpace > start) end = lastSpace;
    }

    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);

    if (end >= clean.length) break;
    start = end - overlap; // step forward with overlap
    if (start < 0) start = 0;
  }

  return chunks;
}

/**
 * Full indexing pipeline for a single uploaded document:
 * read -> chunk -> embed -> upsert into Qdrant.
 *
 * Every chunk carries the same `docId` so the whole document can be deleted
 * later with one filtered delete, even if two uploads share a filename.
 *
 * @param {{ filePath: string, originalName: string, docId?: string }} input
 */
export async function indexDocument({ filePath, originalName, docId }) {
  const collection = await ensureCollection();

  const text = await readDocumentText(filePath);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    throw new UnprocessableDocumentError(
      "No extractable text found — the file may be empty or a scanned/image-only PDF"
    );
  }

  const vectors = await embedTexts(chunks);
  const indexedAt = new Date().toISOString();
  const kind = SUPPORTED_EXTENSIONS[path.extname(filePath).toLowerCase()] ?? "Unknown";

  const points = chunks.map((chunk, i) => ({
    id: crypto.randomUUID(),
    vector: vectors[i],
    payload: {
      text: chunk,
      source: originalName,
      docId: docId ?? crypto.randomUUID(),
      kind,
      filePath,
      chunkIndex: i,
      indexedAt,
    },
  }));

  await qdrant.upsert(collection, { wait: true, points });

  return { chunks: chunks.length, collection, kind, indexedAt };
}
