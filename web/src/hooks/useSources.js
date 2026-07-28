import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  deleteSource as apiDelete,
  getSources,
  isAbort,
  pollJob,
  uploadFile,
} from "../api/client";

let tempCounter = 0;

/**
 * Owns the document library: what's indexed, what's mid-upload, and deletion.
 *
 * In-flight uploads live in their own list (`pending`) with a small state
 * machine — uploading -> indexing -> done | error — so the UI can show real
 * progress instead of a spinner, and a failed file stays visible with its
 * reason until the user dismisses it.
 */
export function useSources() {
  const [sources, setSources] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // One controller for the whole hook: aborts everything on unmount.
  const abortRef = useRef(null);
  if (abortRef.current === null) abortRef.current = new AbortController();

  const refresh = useCallback(async () => {
    try {
      setSources(await getSources({ signal: abortRef.current.signal }));
      setError(null);
    } catch (err) {
      if (isAbort(err)) return;
      setError(err instanceof ApiError ? err.message : "Couldn't load your sources.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = abortRef.current;
    refresh();
    return () => controller.abort();
  }, [refresh]);

  const patchPending = useCallback((id, patch) => {
    setPending((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  /** Upload and index one file, tracking it through both phases. */
  const addFile = useCallback(
    async (file) => {
      const id = `pending-${++tempCounter}`;
      const { signal } = abortRef.current;

      setPending((list) => [
        ...list,
        { id, name: file.name, size: file.size, phase: "uploading", progress: 0 },
      ]);

      try {
        const { jobId } = await uploadFile(file, {
          signal,
          onProgress: (fraction) => patchPending(id, { progress: fraction }),
        });

        patchPending(id, { phase: "indexing", progress: 1 });
        await pollJob("index", jobId, { signal });

        setPending((list) => list.filter((p) => p.id !== id));
        await refresh();
      } catch (err) {
        if (isAbort(err)) {
          setPending((list) => list.filter((p) => p.id !== id));
          return;
        }
        patchPending(id, {
          phase: "error",
          error: err instanceof ApiError ? err.message : "Something went wrong.",
        });
      }
    },
    [patchPending, refresh]
  );

  const addFiles = useCallback(
    (files) => Promise.all([...files].map(addFile)),
    [addFile]
  );

  const dismissPending = useCallback((id) => {
    setPending((list) => list.filter((p) => p.id !== id));
  }, []);

  /** Optimistic remove, restored if the server rejects it. */
  const remove = useCallback(async (docId) => {
    let snapshot;
    setSources((list) => {
      snapshot = list;
      return list.filter((s) => s.docId !== docId);
    });

    try {
      await apiDelete(docId, { signal: abortRef.current.signal });
    } catch (err) {
      if (isAbort(err)) return;
      setSources(snapshot);
      setError(err instanceof ApiError ? err.message : "Couldn't delete that source.");
    }
  }, []);

  const totalChunks = sources.reduce((sum, s) => sum + s.chunks, 0);

  return {
    sources,
    pending,
    loading,
    error,
    totalChunks,
    addFiles,
    remove,
    dismissPending,
    refresh,
  };
}
