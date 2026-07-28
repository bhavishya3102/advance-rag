import fsp from "node:fs/promises";
import { config } from "./config.js";
import { qdrant } from "./qdrant.js";

const SCROLL_PAGE = 512;
// Safety valve so a huge collection can't pin the event loop on one request.
const MAX_PAGES = 200;

/** Qdrant throws a 404-ish error when the collection has never been created. */
function isMissingCollection(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 404 || /doesn't exist|not found/i.test(err?.message ?? "");
}

/**
 * List the indexed documents, aggregated from the chunks stored in Qdrant.
 * One entry per `docId`, newest first.
 *
 * @returns {Promise<Array<{ docId, name, kind, chunks, indexedAt }>>}
 */
export async function listSources() {
  const docs = new Map();
  let offset;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await qdrant.scroll(config.qdrant.collection, {
        limit: SCROLL_PAGE,
        offset,
        with_payload: ["docId", "source", "kind", "indexedAt"],
        with_vector: false,
      });

      for (const { payload } of res.points) {
        // Chunks indexed before docId existed still group by filename.
        const key = payload.docId ?? `legacy:${payload.source}`;
        const doc = docs.get(key);
        if (doc) doc.chunks += 1;
        else
          docs.set(key, {
            docId: key,
            name: payload.source ?? "(unknown)",
            kind: payload.kind ?? "Unknown",
            chunks: 1,
            indexedAt: payload.indexedAt ?? null,
          });
      }

      offset = res.next_page_offset;
      if (!offset) break;
    }
  } catch (err) {
    if (isMissingCollection(err)) return [];
    throw err;
  }

  return [...docs.values()].sort((a, b) =>
    String(b.indexedAt ?? "").localeCompare(String(a.indexedAt ?? ""))
  );
}

/**
 * Delete every chunk belonging to a document, plus the uploaded file it came
 * from. Returns false if the document isn't in the index.
 *
 * @param {string} docId
 */
export async function deleteSource(docId) {
  const collection = config.qdrant.collection;

  let points;
  try {
    // Grab one chunk first: it tells us the file on disk, and confirms the doc exists.
    const res = await qdrant.scroll(collection, {
      limit: 1,
      filter: { must: [{ key: "docId", match: { value: docId } }] },
      with_payload: ["filePath"],
      with_vector: false,
    });
    points = res.points;
  } catch (err) {
    if (isMissingCollection(err)) return false;
    throw err;
  }

  if (points.length === 0) return false;

  await qdrant.delete(collection, {
    wait: true,
    filter: { must: [{ key: "docId", match: { value: docId } }] },
  });

  const filePath = points[0].payload?.filePath;
  if (filePath) await fsp.unlink(filePath).catch(() => {});

  return true;
}
