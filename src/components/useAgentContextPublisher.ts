import { useEffect, useRef, useState } from "react";
import type { AgentEditorSnapshot } from "../core/agentContext";
import {
  motionTime,
  previewInterval,
  previewTime,
} from "../core/motionPlayback";
import { platform } from "../platform";
import type { CanvasSelection } from "./editorCanvasCoordinator";
import type { useEditorSession } from "./useEditorSession";
import type { useMotionWorkspace } from "./MotionWorkspace";

/** Desktop capability is opt-in; browser editing never needs a context store. */
export function useMcpEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true,
      changed = false;
    const stop = platform.onMcpEnabledChanged?.((value) => {
      changed = true;
      if (live) setEnabled(value);
    });
    void platform
      .getMcpEnabled?.()
      .then((value) => {
        if (live && !changed) setEnabled(value);
      })
      .catch(() => {});
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  return enabled;
}

declare global {
  interface Window {
    agentWorkspaceIdle?: (documentId: string) => boolean;
  }
}

export function useAgentContextPublisher(
  controller: ReturnType<typeof useEditorSession>,
  selection: CanvasSelection,
  workspace: ReturnType<typeof useMotionWorkspace>,
  mediaPreview: boolean,
) {
  useEffect(() => {
    const idle = (id: string) => {
      const focused = document.activeElement;
      return (
        controller.snapshotRef.current?.deck.id === id &&
        !controller.session.hasUnacceptedWork &&
        !workspace.draft &&
        !workspace.preview &&
        !(
          focused instanceof HTMLElement &&
          (focused.isContentEditable ||
            focused.matches("input,textarea,[role=textbox]"))
        )
      );
    };
    window.agentWorkspaceIdle = idle;
    return () => {
      if (window.agentWorkspaceIdle === idle) delete window.agentWorkspaceIdle;
    };
  }, [
    controller.session,
    controller.snapshotRef,
    workspace.draft,
    workspace.preview,
  ]);
  const enabled = useMcpEnabled();
  const current = controller.snapshot;
  const documentId = current?.deck.id;
  const documentEpoch = controller.epochRef.current;
  const preview = workspace.preview;
  const stageIndex = preview?.stageIndex ?? workspace.cursor.stageIndex;
  const timeline =
    workspace.open && workspace.motion?.stages.length
      ? {
          selectedStageIndex: workspace.active,
          stageIndex,
          stageId:
            stageIndex === -1
              ? null
              : (workspace.motion.stages[stageIndex]?.id ?? null),
          // A running informational cursor is deliberately not a publication dependency.
          stageTimeMs: preview?.time ?? workspace.cursor.time,
          running: preview?.running ?? false,
          sampledAtMs: 0,
          draft: !!workspace.draft,
          playbackAnchor: preview
            ? { timeMs: preview.time, startedAtMs: preview.startedAt }
            : null,
        }
      : null;
  const snapshot: AgentEditorSnapshot | null =
    enabled && current && documentEpoch
      ? {
          documentId: current.deck.id,
          documentEpoch,
          observedRevision: controller.revisionRef.current,
          page: {
            kind: current.deck.templateIds.includes(current.slide.id)
              ? "template"
              : "slide",
            id: current.slide.id,
          },
          selectionScopeId: selection.scopeId,
          selectionIds: selection.elementIds,
          mode:
            workspace.editingController !== controller
              ? "motion-state-edit"
              : preview
                ? "motion-preview"
                : mediaPreview
                  ? "media-preview"
                  : "edit",
          timeline,
        }
      : null;
  const snapshotKey = JSON.stringify(snapshot);
  const latest = useRef({ snapshot, workspace });
  latest.current = { snapshot, workspace };
  const publish = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (
      !enabled ||
      !documentId ||
      !documentEpoch ||
      !platform.editorAgentContext
    )
      return;
    let live = true,
      token: string | null = null,
      sequence = 0;
    const send = () => {
      const { snapshot, workspace } = latest.current;
      if (
        !live ||
        !token ||
        !snapshot ||
        snapshot.documentId !== documentId ||
        snapshot.documentEpoch !== documentEpoch
      )
        return;
      const value = structuredClone(snapshot);
      if (value.timeline) {
        const now = Date.now();
        value.timeline.sampledAtMs = now;
        if (workspace.preview && workspace.motion) {
          const interval = previewInterval(
            workspace.motion,
            workspace.preview,
            now,
          );
          value.timeline.stageTimeMs = interval.waits
            ? previewTime(workspace.preview, now)
            : motionTime(workspace.preview, interval.duration, now);
        }
      }
      void platform.editorAgentContext!({
        type: "publish",
        token,
        sequence: ++sequence,
        snapshot: value,
      }).catch(() => console.warn("Could not publish MCP editor context"));
    };
    publish.current = send;
    void platform
      .editorAgentContext({ type: "attach", documentId, documentEpoch })
      .then((reply) => {
        token = reply.token;
        if (!live) {
          if (token)
            void platform.editorAgentContext!({ type: "detach", token }).catch(
              () => {},
            );
          return;
        }
        send();
      })
      .catch(() => console.warn("Could not attach MCP editor context"));
    return () => {
      live = false;
      if (publish.current === send) publish.current = null;
      if (token)
        void platform.editorAgentContext!({ type: "detach", token }).catch(
          () => {},
        );
    };
  }, [enabled, documentId, documentEpoch]);

  useEffect(() => {
    publish.current?.();
  }, [snapshotKey]);
}
