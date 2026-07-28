/**
 * Thin API layer over the Express backend.
 *
 * Every call is abortable, every failure surfaces as an ApiError with a message
 * fit to show a user, and job polling is bounded so a stuck worker can never
 * leave the UI spinning forever.
 */

const BASE = "/api";
const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(message, { status = 0, cause } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.cause = cause;
  }
}

/** True for "the user navigated away / we cancelled", which is never an error. */
export const isAbort = (err) =>
  err?.name === "AbortError" || err?.name === "TimeoutError";

/**
 * Merge an external AbortSignal with a timeout, so a request is cancelled by
 * whichever fires first. Returns [signal, cleanup].
 */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function request(path, { signal, timeout = REQUEST_TIMEOUT_MS, ...init } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: withTimeout(signal, timeout),
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch (err) {
    if (isAbort(err) && signal?.aborted) throw err;
    if (isAbort(err)) throw new ApiError("The server took too long to respond.", { cause: err });
    throw new ApiError("Can't reach the server. Is it running on port 8000?", { cause: err });
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, {
      status: res.status,
    });
  }
  return body;
}

const json = (path, method, payload, opts) =>
  request(path, {
    ...opts,
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

/* ------------------------------------------------------------------ api */

export const getHealth = (opts) => request("/health", opts);
export const getConfig = (opts) => request("/config", opts);
export const getSources = (opts) => request("/sources", opts).then((r) => r.sources);
export const deleteSource = (docId, opts) =>
  request(`/sources/${encodeURIComponent(docId)}`, { ...opts, method: "DELETE" });
export const askQuestion = (query, opts) => json("/query", "POST", { query }, opts);

/**
 * Upload a file. Uses XMLHttpRequest rather than fetch because it's the only
 * way to report upload progress, which matters for 25 MB PDFs.
 *
 * @param {File} file
 * @param {{ onProgress?: (fraction: number) => void, signal?: AbortSignal }} opts
 */
export function uploadFile(file, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/index`);
    xhr.responseType = "json";

    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    });

    xhr.addEventListener("load", () => {
      cleanup();
      const body = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else
        reject(
          new ApiError(body?.error ?? `Upload failed (${xhr.status})`, { status: xhr.status })
        );
    });

    xhr.addEventListener("error", () => {
      cleanup();
      reject(new ApiError("Upload failed — the server may be down."));
    });

    xhr.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Upload cancelled", "AbortError"));
    });

    xhr.send(form);
  });
}

/* -------------------------------------------------------------- polling */

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });

/**
 * Poll a job until it completes or fails.
 *
 * Starts fast (jobs on a warm worker finish in ~2s) then eases off, so a slow
 * job doesn't generate hundreds of requests. Gives up after `timeoutMs`.
 *
 * @param {"index" | "query"} kind
 * @param {string} jobId
 * @param {{ signal?: AbortSignal, onState?: (status: string) => void, timeoutMs?: number }} opts
 * @returns {Promise<object>} the job's `result`
 */
export async function pollJob(kind, jobId, { signal, onState, timeoutMs = 120_000 } = {}) {
  const startedAt = Date.now();
  let delay = 400;

  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new ApiError("Timed out waiting for the job to finish. Is the worker running?");
    }

    const job = await request(`/${kind}/${encodeURIComponent(jobId)}`, { signal });
    onState?.(job.status);

    if (job.status === "completed") return job.result;
    if (job.status === "failed") throw new ApiError(job.error || "The job failed.");

    await sleep(delay, signal);
    delay = Math.min(delay * 1.4, 2500);
  }
}
