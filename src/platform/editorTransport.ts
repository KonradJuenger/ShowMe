import type { EditorTransport } from "../core/editorSession";
import type { Platform } from "./api";

/** Maps the platform document boundary to the editor's host-independent transport. */
export type TransportPlatform = Pick<Platform,
  "documentProjection" | "documentCommit" | "documentAcquireLeases" |
  "documentRenewLeases" | "documentReleaseLeases" | "documentUndo" |
  "documentRedo" | "documentHistoryState" | "onDocumentAccepted" |
  "onDocumentInvalidated">;

export function editorTransport(platform: TransportPlatform): EditorTransport {
  const requireMethod = <T>(method: T | undefined): T => {
    if (!method) throw new Error("Document host is unavailable");
    return method;
  };
  return {
    projection: (id, slideId) => requireMethod(platform.documentProjection)(id, slideId),
    commit: (id, transaction) => requireMethod(platform.documentCommit)(id, transaction),
    acquire: (id, scopes) => requireMethod(platform.documentAcquireLeases)(id, scopes),
    renew: (id, tokens) => requireMethod(platform.documentRenewLeases)(id, tokens),
    release: (id, tokens) => requireMethod(platform.documentReleaseLeases)(id, tokens),
    undo: (id, tokens) => requireMethod(platform.documentUndo)(id, tokens),
    redo: (id, tokens) => requireMethod(platform.documentRedo)(id, tokens),
    historyState: (id) => requireMethod(platform.documentHistoryState)(id),
    subscribeAccepted: (id, callback) => requireMethod(platform.onDocumentAccepted)(
      (event) => { if (event.documentId === id) callback(event.accepted); }),
    ...(platform.onDocumentInvalidated
      ? {
          subscribeInvalidated: (id: string, callback: () => void) =>
            platform.onDocumentInvalidated!(
              (event) => { if (event.documentId === id) callback(); },
            ),
        }
      : {}),
  };
}
