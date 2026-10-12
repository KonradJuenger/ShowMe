import { Profiler, useCallback, useEffect, useRef, useState } from "react";
import { platform } from "./platform";
import { performanceEnabled, recordPerformance } from "./core/performance";
import { Editor } from "./components/Editor";
import { EffectErrorMessage } from "./components/EffectErrorMessage";
import type { DocumentSummary } from "./core/documentSummary";

export function EditorApp() {
  const [active, setActive] = useState<string | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const clientDocumentId = useRef<string | null>(null);
  const automaticDocumentId = useRef<string | null>(null);
  const startup = useRef<Promise<{
    document: DocumentSummary | null;
    automatic: boolean;
  }> | null>(null);

  const releaseAutomaticDocument = useCallback(async () => {
    const id = automaticDocumentId.current;
    automaticDocumentId.current = null;
    if (id && (await platform.documentProjection!(id)).revision === 0)
      await platform.closeDocument?.(id);
  }, []);

  const newPresentation = useCallback(
    async (name?: string) => {
      await releaseAutomaticDocument();
      const document = await platform.createDocument(name ?? "Untitled");
      if (!document) throw new Error("Could not create a presentation");
      setNotice("");
      setActive(document.id);
      automaticDocumentId.current = name === undefined ? document.id : null;
    },
    [releaseAutomaticDocument],
  );

  useEffect(() => {
    let live = true;
    startup.current ??= platform.currentDocument().then(async (document) => ({
      document: document ?? (await platform.createDocument("Untitled")),
      automatic: !document,
    }));
    void startup.current
      .then(({ document, automatic }) => {
        if (!live) return;
        automaticDocumentId.current = automatic ? (document?.id ?? null) : null;
        if (!clientDocumentId.current) setActive(document?.id ?? null);
      })
      .catch((cause) => live && setError(String(cause)));
    const unsubscribe = platform.onDocumentOpened((document) => {
      if (!live) return;
      void releaseAutomaticDocument().catch((cause) => setError(String(cause)));
      setActive(document.id);
      setNotice("");
      setEditorRevision((value) => value + 1);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [releaseAutomaticDocument]);

  useEffect(() => {
    if (!platform.collaborationStatus) return;
    let live = true;
    const update = (status: import("./platform/api").CollaborationStatus) => {
      if (!live) return;
      if (status.clientDocumentId) {
        clientDocumentId.current = status.clientDocumentId;
        setActive(status.clientDocumentId);
      } else if (status.clientStatus === "idle" && clientDocumentId.current) {
        clientDocumentId.current = null;
        void newPresentation().catch((cause) => setError(String(cause)));
      }
    };
    const unsubscribe = platform.onCollaborationStatus?.(update);
    void platform
      .collaborationStatus()
      .then(update)
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [newPresentation]);

  useEffect(() => {
    const releaseInspectorFocus = (event: PointerEvent) => {
      if (event.button !== 0 || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      const focused = document.activeElement as HTMLElement | null;
      if (
        target?.closest(".stage, .element-hit") &&
        focused &&
        !focused.contains(target) &&
        !focused.matches("textarea.inline-text") &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(focused.tagName)
      )
        focused.blur();
    };
    document.addEventListener("pointerdown", releaseInspectorFocus, true);
    return () =>
      document.removeEventListener("pointerdown", releaseInspectorFocus, true);
  }, []);

  if (!active)
    return (
      <main className="startup-status">
        <p role={error ? "alert" : "status"}>
          {error ? (
            <EffectErrorMessage message={error} />
          ) : (
            "Opening presentation…"
          )}
        </p>
        {error && <button onClick={() => location.reload()}>Retry</button>}
      </main>
    );

  const editor = (
    <Editor
      key={`${active}:${editorRevision}`}
      deckId={active}
      initialStatus={notice}
      onHome={() =>
        void newPresentation().catch((cause) => setError(String(cause)))
      }
      onNewPresentation={newPresentation}
      onPresentationOpened={(document, message = "") => {
        void releaseAutomaticDocument().catch((cause) =>
          setError(String(cause)),
        );
        setActive(document.id);
        setNotice(message);
      }}
    />
  );
  return performanceEnabled() ? (
    <Profiler
      id="Editor"
      onRender={(
        _id,
        phase,
        actualDuration,
        _baseDuration,
        startTime,
        commitTime,
      ) => {
        recordPerformance(`react.${phase}`, startTime, actualDuration);
        recordPerformance(
          "react.commitDelay",
          startTime,
          commitTime - startTime,
        );
      }}
    >
      {editor}
    </Profiler>
  ) : (
    editor
  );
}
