import styles from "./Header.module.css";

export default function Header({ chunkCount, sourceCount, railOpen, onToggleRail }) {
  return (
    <header className={styles.header}>
      <button
        type="button"
        className={styles.railToggle}
        onClick={onToggleRail}
        aria-expanded={railOpen}
        aria-label={railOpen ? "Close the archive panel" : "Open the archive panel"}
      >
        <span className={styles.bars} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>

      <div className={styles.mark}>
        <span className={styles.eyebrow}>Retrieval&#8202;—&#8202;Augmented</span>
        <h1 className={styles.wordmark}>
          Reading <em>Room</em>
        </h1>
      </div>

      <div className={styles.meter} aria-live="polite">
        {sourceCount > 0 ? (
          <>
            <span className={styles.dot} data-live="true" aria-hidden="true" />
            <span className={styles.meterText}>
              <b>{sourceCount}</b> {sourceCount === 1 ? "source" : "sources"}
              <span className={styles.divider} aria-hidden="true">
                /
              </span>
              <b>{chunkCount.toLocaleString()}</b> chunks indexed
            </span>
          </>
        ) : (
          <>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.meterText}>Archive empty</span>
          </>
        )}
      </div>
    </header>
  );
}
