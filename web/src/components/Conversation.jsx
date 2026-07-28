import { useEffect, useLayoutEffect, useRef } from "react";
import Markdown from "react-markdown";
import RetrievalTrace from "./RetrievalTrace";
import { formatDuration } from "../lib/format";
import styles from "./Conversation.module.css";

const EXAMPLES = [
  "Summarise the key points of this document.",
  "What does it say about limits or thresholds?",
  "What steps does it recommend, and in what order?",
];

export default function Conversation({ turns, hasSources, loadingSources, onAskExample }) {
  const scrollRef = useRef(null);
  const endRef = useRef(null);
  // Only follow the conversation if the reader is already at the bottom —
  // yanking them down mid-sentence while they scroll back is hostile.
  const pinned = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      pinned.current = distance < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (pinned.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className={styles.scroll} ref={scrollRef}>
        <div className={styles.column}>
          <Welcome
            hasSources={hasSources}
            loading={loadingSources}
            onAskExample={onAskExample}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.scroll} ref={scrollRef}>
      <div className={styles.column}>
        <ol className={styles.turns}>
          {turns.map((turn) => (
            <Turn key={turn.id} turn={turn} />
          ))}
        </ol>
        <div ref={endRef} aria-hidden="true" />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- welcome */

function Welcome({ hasSources, loading, onAskExample }) {
  return (
    <div className={styles.welcome}>
      <p className={styles.welcomeEyebrow}>No conversation yet</p>
      <h2 className={styles.welcomeTitle}>
        Ask anything of your <em>own</em> documents.
      </h2>
      <p className={styles.welcomeBody}>
        Each question is rewritten, stepped back from, and turned into a hypothetical
        answer — six searches in all. The results are fused by rank, and every answer
        keeps the trace that produced it.
      </p>

      {loading ? null : hasSources ? (
        <div className={styles.examples}>
          <span className={styles.examplesLabel}>Try</span>
          <ul>
            {EXAMPLES.map((example, i) => (
              <li key={example} style={{ animationDelay: `${240 + i * 80}ms` }}>
                <button type="button" onClick={() => onAskExample(example)}>
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={styles.welcomeCta}>
          <span aria-hidden="true">←</span> Add a PDF or Markdown file to the archive to
          get started.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ turn */

const THINKING_STEPS = [
  "Rewriting the question",
  "Writing a hypothetical answer",
  "Searching with six variants",
  "Fusing results by rank",
  "Reading the top chunks",
];

function Turn({ turn }) {
  const pendingTurn = turn.phase === "queued" || turn.phase === "thinking";

  return (
    <li className={styles.turn}>
      <div className={styles.question}>
        <span className={styles.questionMark} aria-hidden="true" />
        <p>{turn.question}</p>
      </div>

      <div className={styles.answerSlot}>
        {pendingTurn && <Thinking />}

        {turn.phase === "error" && (
          <p className={styles.failure} role="alert">
            <strong>Couldn&rsquo;t answer that.</strong> {turn.error}
          </p>
        )}

        {turn.phase === "done" && (
          <>
            <div className={styles.answer} aria-live="polite">
              <Markdown
                components={{
                  a: (props) => <a {...props} target="_blank" rel="noreferrer noopener" />,
                }}
              >
                {turn.answer}
              </Markdown>
            </div>

            <RetrievalTrace
              queries={turn.queries}
              sources={turn.sources}
              elapsed={formatDuration(turn.elapsedMs)}
            />
          </>
        )}
      </div>
    </li>
  );
}

function Thinking() {
  return (
    <div className={styles.thinking} aria-live="polite" aria-busy="true">
      <span className="visually-hidden">Working on your answer</span>
      <ul aria-hidden="true">
        {THINKING_STEPS.map((step, i) => (
          <li key={step} style={{ animationDelay: `${i * 900}ms` }}>
            {step}
          </li>
        ))}
      </ul>
    </div>
  );
}
