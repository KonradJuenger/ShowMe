import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { platform } from "../platform";
import type { CollaborationStatus } from "../platform/api";
import {
  COLLAB_PROTOCOL_VERSION,
  type DiscoveryRecord,
} from "../core/collaboration/protocol";
import "./Collaboration.css";

export function Collaboration({
  documentId,
  onLeave,
}: {
  documentId?: string;
  onLeave?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CollaborationStatus | null>(null);
  const [nearby, setNearby] = useState<DiscoveryRecord[]>([]);
  const [interfaces, setInterfaces] = useState<
    Array<{ name: string; address: string; recommended: boolean }>
  >([]);
  const [selectedInterface, setSelectedInterface] = useState("");
  const [manual, setManual] = useState("");
  const [name, setName] = useState("Guest");
  const [error, setError] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [panelPosition, setPanelPosition] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (!platform.collaborationStatus) return;
    let live = true;
    const unsubStatus = platform.onCollaborationStatus?.((value) => {
      if (live) setStatus(value);
    });
    const unsubDiscovery = platform.onCollaborationDiscovery?.((value) => {
      if (live) setNearby(value);
    });
    void platform
      .collaborationStatus()
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    if (open)
      void platform
        .collaborationDiscover?.()
        .then((value) => {
          if (live) setNearby(value);
        })
        .catch((cause) => {
          if (live) setError(String(cause));
        });
    if (open)
      void platform
        .collaborationInterfaces?.()
        .then((value) => {
          if (!live) return;
          setInterfaces(value);
          setSelectedInterface(
            (current) =>
              current ||
              value.find((entry) => entry.recommended)?.address ||
              value[0]?.address ||
              "",
          );
        })
        .catch((cause) => {
          if (live) setError(String(cause));
        });
    return () => {
      live = false;
      unsubStatus?.();
      unsubDiscovery?.();
    };
  }, [open]);
  if (!platform.collaborationStatus) return null;

  const run = async (work: () => Promise<unknown>) => {
    try {
      setError("");
      await work();
      setStatus(await platform.collaborationStatus!());
    } catch (cause) {
      setError(String(cause));
    }
  };
  const joined = status?.clientStatus && status.clientStatus !== "idle";
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={documentId ? "tool-button" : "km-action-btn"}
        aria-expanded={open}
        aria-label="Colab"
        onClick={() => {
          const bounds = buttonRef.current?.getBoundingClientRect();
          if (bounds)
            setPanelPosition({
              top: bounds.bottom + 8,
              left: Math.max(8, Math.min(bounds.left, innerWidth - 348)),
            });
          setOpen(!open);
        }}
      >
        Colab
      </button>
      {open &&
        createPortal(
          <section
            className="colab-panel"
            role="dialog"
            aria-label="Colab"
            style={{
              left: panelPosition.left,
              top: panelPosition.top,
            }}
          >
            <h2>Collaboration · Experimental</h2>
            <p>
              Trusted LAN only. Traffic is not encrypted. Do not use on
              untrusted or shared networks where confidentiality matters.
            </p>
            {error && <p role="alert">{error}</p>}
            {status?.hosted ? (
              <>
                <p>Colab active — {status.hosted.presentationName}</p>
                <details>
                  <summary>Manual connection details</summary>
                  <p>
                    {status.hosted.address}:{status.hosted.port}
                  </p>
                  <p style={{ overflowWrap: "anywhere" }}>
                    Session ID: {status.hosted.sessionId}
                  </p>
                </details>
                <h3>Connected</h3>
                {status.connected.length ? (
                  status.connected.map((peer) => (
                    <p key={peer.id}>
                      {peer.displayName} · {peer.deviceName}
                    </p>
                  ))
                ) : (
                  <p>None</p>
                )}
                <h3>Pending</h3>
                {status.pending.length ? (
                  status.pending.map((peer) => (
                    <div key={peer.id}>
                      <p>
                        {peer.displayName} · {peer.deviceName} · {peer.address}
                      </p>
                      <button
                        onClick={() =>
                          void run(() =>
                            platform.collaborationApprove!(peer.id),
                          )
                        }
                      >
                        Approve
                      </button>{" "}
                      <button
                        onClick={() =>
                          void run(() => platform.collaborationReject!(peer.id))
                        }
                      >
                        Reject
                      </button>
                    </div>
                  ))
                ) : (
                  <p>None</p>
                )}
                <button
                  onClick={() => void run(() => platform.collaborationStop!())}
                >
                  Stop Colab
                </button>
              </>
            ) : joined ? (
              <>
                <p>
                  {status?.clientStatus === "waiting"
                    ? "Waiting for host approval…"
                    : status?.clientStatus === "connected"
                      ? `Connected to ${status.joinedName}`
                      : status?.clientStatus === "lost"
                        ? "Host connection lost. Last received presentation remains visible."
                        : status?.clientStatus === "incompatible"
                          ? status.error ||
                            "This collaboration session uses an incompatible ShowMe version."
                          : status?.clientStatus === "rejected"
                            ? "The host rejected the join request."
                            : "Connecting…"}
                </p>
                <button
                  onClick={() =>
                    void run(async () => {
                      await platform.collaborationLeave!();
                      onLeave?.();
                    })
                  }
                >
                  Leave Session
                </button>
              </>
            ) : (
              <>
                {documentId && (
                  <>
                    {interfaces.length > 1 && (
                      <label>
                        LAN interface
                        <select
                          value={selectedInterface}
                          onChange={(event) =>
                            setSelectedInterface(event.target.value)
                          }
                        >
                          {interfaces.map((entry) => (
                            <option key={entry.address} value={entry.address}>
                              {entry.name} ({entry.address})
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button
                      className="primary"
                      onClick={() =>
                        void run(() =>
                          platform.collaborationStart!(
                            documentId,
                            selectedInterface || undefined,
                          ),
                        )
                      }
                    >
                      Start Colab
                    </button>
                  </>
                )}
                <h3>Nearby Sessions</h3>
                {nearby.length ? (
                  nearby.map((record) => (
                    <div key={record.sessionId} style={{ marginBottom: 12 }}>
                      <strong>{record.presentationName}</strong>
                      <br />
                      Hosted by {record.hostName}
                      <br />
                      <button
                        className="primary"
                        onClick={() =>
                          void run(() =>
                            platform.collaborationJoin!(record, name),
                          )
                        }
                      >
                        Join
                      </button>
                    </div>
                  ))
                ) : (
                  <p>No nearby sessions found.</p>
                )}
                <label>
                  Display name{" "}
                  <input
                    value={name}
                    maxLength={100}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <details>
                  <summary>Manual connection</summary>
                  <label>
                    Host LAN address{" "}
                    <input
                      value={manual}
                      onChange={(event) => setManual(event.target.value)}
                    />
                  </label>
                  <p>
                    Enter a private LAN address and session ID from the host.
                  </p>
                  <ManualJoin address={manual} name={name} run={run} />
                </details>
              </>
            )}
          </section>,
          document.body,
        )}
    </>
  );
}

function ManualJoin({
  address,
  name,
  run,
}: {
  address: string;
  name: string;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [port, setPort] = useState("");
  const [sessionId, setSessionId] = useState("");
  return (
    <>
      <input
        aria-label="Port"
        placeholder="Port"
        value={port}
        onChange={(event) => setPort(event.target.value)}
      />
      <input
        aria-label="Session ID"
        placeholder="Session ID"
        value={sessionId}
        onChange={(event) => setSessionId(event.target.value)}
      />
      <button
        className="primary"
        onClick={() =>
          void run(() =>
            platform.collaborationJoin!(
              {
                address,
                port: Number(port),
                sessionId,
                presentationName: "Presentation",
                hostName: address,
                protocolVersion: COLLAB_PROTOCOL_VERSION,
              },
              name,
            ),
          )
        }
      >
        Connect
      </button>
    </>
  );
}
