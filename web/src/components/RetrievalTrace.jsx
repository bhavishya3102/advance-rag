import { useId, useMemo, useState } from "react";
import { truncate } from "../lib/format";
import styles from "./RetrievalTrace.module.css";

/**
 * What each query variant is for. Shown next to the variant so the trace
 * teaches the technique rather than just dumping strings.
 */
const VARIANTS = [
  ["rewritten", "Rewritten", "typos fixed, made explicit and self-contained"],
  ["stepBack", "Step-back", "a broader question, for background context"],
  ["hyde", "HyDE", "a hypothetical answer — embedded as if it were a document"],
];

const SUBQUERY_NOTE = "one focused part of the question";

export default function RetrievalTrace({ queries, sources = [], elapsed }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const variants = useMemo(() => {
    if (!queries) return [];
    const named = VARIANTS.filter(([key]) => queries[key]?.trim()).map(
      ([key, label, note]) => ({ key, label, note, text: queries[key] })
    );
    const subs = (queries.subQueries ?? []).map((text, i) => ({
      key: `subQuery${i + 1}`,
      label: `Sub-query ${i + 1}`,
      note: SUBQUERY_NOTE,
      text,
    }));
    return [...named, ...subs];
  }, [queries]);

  const maxRrf = useMemo(
    () => Math.max(...sources.map((s) => s.rrfScore ?? 0), Number.EPSILON),
    [sources]
  );

  if (variants.length === 0 && sources.length === 0) return null;

  return (
    <section className={styles.trace}>
      <button
        type="button"
        className={styles.summary}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className={styles.chevron} data-open={open || undefined} aria-hidden="true">
          <svg viewBox="0 0 12 12">
            <path
              d="M4 2l4 4-4 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className={styles.summaryLabel}>Retrieval trace</span>
        <span className={styles.summaryStats}>
          {variants.length > 0 && <b>{variants.length}</b>}
          {variants.length > 0 && " variants"}
          {variants.length > 0 && sources.length > 0 && (
            <span className={styles.sep} aria-hidden="true">
              ·
            </span>
          )}
          {sources.length > 0 && <b>{sources.length}</b>}
          {sources.length > 0 && " chunks"}
          {elapsed && (
            <>
              <span className={styles.sep} aria-hidden="true">
                ·
              </span>
              {elapsed}
            </>
          )}
        </span>
      </button>

      <div className={styles.panelWrap} data-open={open || undefined}>
        <div className={styles.panelInner}>
          <div id={panelId} className={styles.panel} hidden={!open}>
            {variants.length > 0 && (
              <div className={styles.block}>
                <h3 className={styles.blockTitle}>
                  Searched with <span>{variants.length}</span> query variants
                </h3>
                <ul className={styles.variants}>
                  {variants.map((variant) => (
                    <li key={variant.key} className={styles.variant}>
                      <div className={styles.variantHead}>
                        <span className={styles.variantLabel}>{variant.label}</span>
                        <span className={styles.variantNote}>{variant.note}</span>
                      </div>
                      <p className={styles.variantText}>{variant.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {sources.length > 0 && (
              <div className={styles.block}>
                <h3 className={styles.blockTitle}>
                  Fused to the top <span>{sources.length}</span> chunks
                </h3>
                <ol className={styles.chunks}>
                  {sources.map((source, i) => (
                    <ChunkRow
                      key={`${source.source}-${source.chunkIndex}-${i}`}
                      rank={i + 1}
                      source={source}
                      maxRrf={maxRrf}
                    />
                  ))}
                </ol>
                <p className={styles.footnote}>
                  Bar length is the fused rank score. A chunk found by several
                  variants outranks one that topped a single list.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ chunk */

function ChunkRow({ rank, source, maxRrf }) {
  const [expanded, setExpanded] = useState(false);
  const matched = source.matchedBy ?? [];
  const width = `${Math.max(4, ((source.rrfScore ?? 0) / maxRrf) * 100)}%`;
  const long = (source.text?.length ?? 0) > 220;

  return (
    <li className={styles.chunk}>
      <span className={styles.rank}>{String(rank).padStart(2, "0")}</span>

      <div className={styles.chunkBody}>
        <div className={styles.chunkHead}>
          <span className={styles.chunkSource} title={source.source ?? ""}>
            {source.source ?? "unknown"}
            {Number.isInteger(source.chunkIndex) && (
              <span className={styles.chunkIndex}>#{source.chunkIndex}</span>
            )}
          </span>
          <span className={styles.scores}>
            {typeof source.rrfScore === "number" && (
              <span title="Reciprocal Rank Fusion score — this decided the order">
                rrf {source.rrfScore.toFixed(4)}
              </span>
            )}
            {typeof source.score === "number" && (
              <span title="Best raw cosine similarity across the variants">
                cos {source.score.toFixed(3)}
              </span>
            )}
          </span>
        </div>

        <span className={styles.track} aria-hidden="true">
          <span className={styles.bar} style={{ width }} />
        </span>

        {matched.length > 0 && (
          <ul className={styles.matched} aria-label="Found by these query variants">
            {matched.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        )}

        <p className={styles.excerpt}>
          {expanded ? source.text : truncate(source.text, 220)}
        </p>

        {long && (
          <button
            type="button"
            className={styles.more}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Show less" : "Show full chunk"}
          </button>
        )}
      </div>
    </li>
  );
}
