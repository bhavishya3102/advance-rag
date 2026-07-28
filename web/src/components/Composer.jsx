import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./Composer.module.css";

const MAX_CHARS = 2000;
const MAX_ROWS_PX = 200;

export default function Composer({ busy, blocked, hasTurns, onSubmit, onStop, onClear }) {
  const [value, setValue] = useState("");
  const textareaRef = useRef(null);

  // Grow with the content, then scroll internally past a few lines.
  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, []);

  useEffect(resize, [value, resize]);

  // Focus the composer when the app becomes usable.
  useEffect(() => {
    if (!blocked) textareaRef.current?.focus();
  }, [blocked]);

  const submit = useCallback(
    (event) => {
      event?.preventDefault();
      const question = value.trim();
      if (!question || busy || blocked) return;
      onSubmit(question);
      setValue("");
    },
    [blocked, busy, onSubmit, value]
  );

  const onKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit]
  );

  const remaining = MAX_CHARS - value.length;
  const canSend = value.trim().length > 0 && !busy && !blocked;

  return (
    <div className={styles.dock}>
      <form className={styles.composer} onSubmit={submit}>
        <label htmlFor="ask" className="visually-hidden">
          Ask a question about your documents
        </label>

        <textarea
          ref={textareaRef}
          id="ask"
          rows={1}
          className={styles.input}
          value={value}
          maxLength={MAX_CHARS}
          disabled={blocked}
          placeholder={
            blocked ? "Add a source before asking…" : "Ask a question about your documents…"
          }
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className={styles.actions}>
          {busy ? (
            <button type="button" className={styles.stop} onClick={onStop}>
              Stop
            </button>
          ) : (
            <button type="submit" className={styles.send} disabled={!canSend}>
              Ask
              <kbd aria-hidden="true">↵</kbd>
            </button>
          )}
        </div>
      </form>

      <div className={styles.footer}>
        <span className={styles.hint}>
          <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
        </span>

        <span className={styles.right}>
          {remaining < 200 && (
            <span className={styles.counter} data-low={remaining < 40 || undefined}>
              {remaining}
            </span>
          )}
          {hasTurns && !busy && (
            <button type="button" className={styles.clear} onClick={onClear}>
              Clear conversation
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
