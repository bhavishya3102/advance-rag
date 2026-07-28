import { useCallback, useEffect, useState } from "react";
import Header from "./components/Header";
import ArchiveRail from "./components/ArchiveRail";
import Conversation from "./components/Conversation";
import Composer from "./components/Composer";
import { useSources } from "./hooks/useSources";
import { useConversation } from "./hooks/useConversation";
import { getConfig, isAbort } from "./api/client";
import styles from "./App.module.css";

const FALLBACK_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  extensions: [".pdf", ".md", ".markdown", ".txt"],
};

export default function App() {
  const library = useSources();
  const conversation = useConversation();
  const [limits, setLimits] = useState(FALLBACK_LIMITS);
  const [railOpen, setRailOpen] = useState(false);

  // Upload constraints come from the server so the two can never disagree.
  useEffect(() => {
    const controller = new AbortController();
    getConfig({ signal: controller.signal })
      .then(setLimits)
      .catch((err) => {
        if (!isAbort(err)) console.warn("Falling back to default upload limits:", err);
      });
    return () => controller.abort();
  }, []);

  const { ask } = conversation;
  const askExample = useCallback((question) => ask(question), [ask]);

  const hasSources = library.sources.length > 0;

  return (
    <div className={styles.shell}>
      <Header
        chunkCount={library.totalChunks}
        sourceCount={library.sources.length}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((open) => !open)}
      />

      <div className={styles.body}>
        <ArchiveRail
          drawerOpenClass={railOpen ? styles.railOpen : ""}
          library={library}
          limits={limits}
          onClose={() => setRailOpen(false)}
        />

        <main className={styles.main}>
          <Conversation
            turns={conversation.turns}
            hasSources={hasSources}
            loadingSources={library.loading}
            onAskExample={askExample}
          />
          <Composer
            busy={conversation.busy}
            blocked={!hasSources && !library.loading}
            hasTurns={conversation.turns.length > 0}
            onSubmit={conversation.ask}
            onStop={conversation.stop}
            onClear={conversation.clear}
          />
        </main>
      </div>

      {railOpen && (
        <button
          type="button"
          className={styles.scrim}
          aria-label="Close the archive panel"
          onClick={() => setRailOpen(false)}
        />
      )}
    </div>
  );
}
