import { useCallback, useRef, useState } from "react";
import { formatBytes, formatWhen, truncate } from "../lib/format";
import styles from "./ArchiveRail.module.css";

/* ------------------------------------------------------------------ icons */

const Plus = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.icon}>
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const Cross = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.icon}>
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

/* ------------------------------------------------------------- validation */

/** Reject obviously bad files in the browser so the user hears back instantly. */
function validate(file, limits) {
  const dot = file.name.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();

  if (!limits.extensions.includes(ext)) {
    return `“${truncate(file.name, 28)}” isn't a supported type. Add ${limits.extensions.join(", ")}.`;
  }
  if (file.size > limits.maxBytes) {
    return `“${truncate(file.name, 28)}” is ${formatBytes(file.size)} — the limit is ${formatBytes(limits.maxBytes)}.`;
  }
  if (file.size === 0) {
    return `“${truncate(file.name, 28)}” is empty.`;
  }
  return null;
}

/* ------------------------------------------------------------------- rail */

export default function ArchiveRail({ drawerOpenClass = "", library, limits, onClose }) {
  const { sources, pending, loading, error, addFiles, remove, dismissPending } = library;
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState([]);
  // Nested dragenter/dragleave events fire constantly; count them instead of
  // toggling a boolean, or the highlight flickers over child elements.
  const dragDepth = useRef(0);

  const accept = useCallback(
    (fileList) => {
      const files = [...fileList];
      if (files.length === 0) return;

      const problems = files.map((f) => validate(f, limits)).filter(Boolean);
      const usable = files.filter((f) => !validate(f, limits));

      setRejected(problems);
      if (usable.length > 0) addFiles(usable);
    },
    [addFiles, limits]
  );

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      accept(event.dataTransfer.files);
    },
    [accept]
  );

  const onPick = useCallback(
    (event) => {
      accept(event.target.files);
      event.target.value = ""; // let the same file be re-picked
    },
    [accept]
  );

  return (
    <aside className={`${styles.rail} ${drawerOpenClass}`} aria-label="Source archive">
      <div className={styles.head}>
        <h2 className={styles.title}>Archive</h2>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close the archive panel"
        >
          <Cross />
        </button>
      </div>

      <p className={styles.blurb}>
        Everything here is searchable. Answers are drawn only from these documents.
      </p>

      {/* ------------------------------------------------------ dropzone */}
      <div
        className={`${styles.dropzone} ${dragging ? styles.dragging : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDrop={onDrop}
      >
        {/* The input is driven by the button below rather than a <label for>:
            one focusable control, and no reliance on label/id association. */}
        <input
          ref={inputRef}
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          accept={limits.extensions.join(",")}
          className="visually-hidden"
          onChange={onPick}
        />
        <button
          type="button"
          className={styles.dropLabel}
          onClick={() => inputRef.current?.click()}
        >
          <span className={styles.dropIcon} aria-hidden="true">
            <Plus />
          </span>
          <span className={styles.dropTitle}>Add a source</span>
          <span className={styles.dropHint}>
            Drop files here, or <u>browse</u>
          </span>
          <span className={styles.dropMeta}>
            {limits.extensions.join(" · ")} — up to {formatBytes(limits.maxBytes)}
          </span>
        </button>
      </div>

      {rejected.length > 0 && (
        <ul className={styles.rejects}>
          {rejected.map((message) => (
            <li key={message} className={styles.reject}>
              <span>{message}</span>
              <button
                type="button"
                onClick={() => setRejected((list) => list.filter((m) => m !== message))}
                aria-label="Dismiss"
              >
                <Cross />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className={styles.error}>{error}</p>}

      {/* --------------------------------------------------------- list */}
      <div className={styles.listWrap}>
        <div className={styles.listHead}>
          <span>Indexed</span>
          <span aria-hidden="true" className={styles.hairline} />
          <span className={styles.count}>{sources.length}</span>
        </div>

        {loading ? (
          <ul className={styles.list}>
            {[0, 1, 2].map((i) => (
              <li key={i} className={styles.skeleton} style={{ animationDelay: `${i * 90}ms` }} />
            ))}
          </ul>
        ) : (
          <ul className={styles.list}>
            {pending.map((item) => (
              <PendingItem key={item.id} item={item} onDismiss={dismissPending} />
            ))}

            {sources.map((source, i) => (
              <SourceItem
                key={source.docId}
                source={source}
                index={i}
                onRemove={remove}
              />
            ))}

            {sources.length === 0 && pending.length === 0 && (
              <li className={styles.empty}>
                Nothing indexed yet. Add a PDF or Markdown file to begin.
              </li>
            )}
          </ul>
        )}
      </div>
    </aside>
  );
}

/* --------------------------------------------------------------- entries */

function SourceItem({ source, index, onRemove }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li
      className={styles.item}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
    >
      <span className={styles.kind}>{source.kind}</span>

      <div className={styles.itemBody}>
        <p className={styles.name} title={source.name}>
          {source.name}
        </p>
        <p className={styles.itemMeta}>
          {source.chunks} {source.chunks === 1 ? "chunk" : "chunks"}
          {source.indexedAt && (
            <>
              <span className={styles.dot} aria-hidden="true" />
              {formatWhen(source.indexedAt)}
            </>
          )}
        </p>
      </div>

      {confirming ? (
        <span className={styles.confirm}>
          <button type="button" className={styles.confirmYes} onClick={() => onRemove(source.docId)}>
            Remove
          </button>
          <button type="button" className={styles.confirmNo} onClick={() => setConfirming(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={styles.remove}
          onClick={() => setConfirming(true)}
          aria-label={`Remove ${source.name} from the archive`}
        >
          <Cross />
        </button>
      )}
    </li>
  );
}

const PHASE_LABEL = {
  uploading: "Uploading",
  indexing: "Chunking & embedding",
  error: "Failed",
};

function PendingItem({ item, onDismiss }) {
  const failed = item.phase === "error";
  const percent = Math.round((item.progress ?? 0) * 100);

  return (
    <li className={`${styles.item} ${styles.pendingItem}`} data-failed={failed || undefined}>
      <span className={`${styles.kind} ${failed ? styles.kindError : styles.kindBusy}`}>
        {failed ? "!" : percent < 100 ? `${percent}%` : "···"}
      </span>

      <div className={styles.itemBody}>
        <p className={styles.name} title={item.name}>
          {item.name}
        </p>
        <p className={styles.itemMeta}>
          {failed ? item.error : `${PHASE_LABEL[item.phase]} — ${formatBytes(item.size)}`}
        </p>

        {!failed && (
          <span className={styles.track} role="progressbar" aria-valuenow={percent}>
            <span
              className={item.phase === "indexing" ? styles.barIndeterminate : styles.bar}
              style={item.phase === "uploading" ? { width: `${percent}%` } : undefined}
            />
          </span>
        )}
      </div>

      {failed && (
        <button
          type="button"
          className={styles.remove}
          onClick={() => onDismiss(item.id)}
          aria-label="Dismiss this failed upload"
        >
          <Cross />
        </button>
      )}
    </li>
  );
}
