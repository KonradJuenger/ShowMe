import { useEffect, useState } from "react";
import type { McpConnectionInfo } from "../core/agentRead";
import { platform } from "../platform";
import { useMcpEnabled } from "./useAgentContextPublisher";

export function McpSettings() {
  const enabled = useMcpEnabled();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<McpConnectionInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let current = true;
    void platform
      .getMcpEditingEnabled?.()
      .then((value) => {
        if (current) setEditing(value);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    void platform
      .getMcpConnection?.()
      .then((value) => {
        if (current) setConnection(value);
      })
      .catch(() => {
        if (current)
          setConnection({
            status: "unavailable",
            configuration: null,
            instanceId: null,
          });
      });
    return () => {
      current = false;
    };
  }, [enabled, busy]);
  if (!platform.setMcpEnabled) return null;
  return (
    <section className="settings-section" aria-label="MCP">
      <h3>MCP · Experimental</h3>
      <label>
        <input
          type="checkbox"
          checked={pending ?? enabled}
          disabled={busy}
          aria-describedby="mcp-settings-description"
          onChange={(event) => {
            const next = event.currentTarget.checked;
            setPending(next);
            setBusy(true);
            setError("");
            setCopied(false);
            setConnection(null);
            void platform.setMcpEnabled!(next)
              .catch(() => {
                setError("Could not save the MCP setting. Try again.");
              })
              .finally(() => {
                setBusy(false);
                setPending(null);
              });
          }}
        />
        Enable MCP
      </label>
      <p id="mcp-settings-description">
        Allow local agents to inspect presentation context and request slide
        previews. Editing is optional below. Requires ShowMe to stay open and
        Node.js 24 or 26 on this computer.
      </p>
      <label>
        <input
          type="checkbox"
          checked={editing}
          disabled={!enabled || busy}
          aria-describedby="mcp-editing-description"
          onChange={(event) => {
            const next = event.currentTarget.checked;
            setEditing(next);
            setBusy(true);
            setError("");
            void platform.setMcpEditingEnabled!(next)
              .then(setEditing)
              .catch(() => {
                setEditing(!next);
                setError("Could not save the editing setting. Try again.");
              })
              .finally(() => setBusy(false));
          }}
        />
        Allow agent editing
      </label>
      <p id="mcp-editing-description">
        Agents can change text, move and resize objects, change appearance,
        insert text or shapes, and delete objects. Accepted edits have separate
        agent undo controls.
      </p>
      <p role="status">
        {!enabled
          ? "Local connection is off."
          : busy || !connection
            ? "Preparing local connection…"
            : connection.status === "ready"
              ? "Local connection is ready."
              : "Local connection is unavailable. Turn MCP off and on to retry."}
      </p>
      {enabled && connection?.configuration && !busy && (
        <>
          <button
            type="button"
            onClick={() => {
              setError("");
              void platform.writeTextClipboard!(connection.configuration!)
                .then(() => setCopied(true))
                .catch(() =>
                  setError("Could not copy the configuration. Try again."),
                );
            }}
          >
            Copy client configuration
          </button>
          {copied && (
            <p role="status">
              Configuration copied. Add it to your MCP client, then reconnect.
            </p>
          )}
          <p>
            Instance ID: <code>{connection.instanceId}</code>
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
