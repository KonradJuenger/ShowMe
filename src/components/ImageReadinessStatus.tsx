import { useEffect, useState } from "react";
import { platform } from "../platform";
import type { ImageReadiness } from "../core/presentationImages";

export function ImageReadinessStatus({
  documentId,
  slideId,
  slideIds,
}: {
  documentId: string;
  slideId: string;
  slideIds: string[];
}) {
  const [status, setStatus] = useState<ImageReadiness | null>(null);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    let live = true;
    const update = () =>
      void platform
        .imageReadiness?.(documentId, false, slideId)
        .then((value) => {
          if (live) setStatus(value);
        })
        .catch(() => {});
    const unsubscribe = platform.onImageReadiness?.((value) => {
      if (live && !value) {
        setStatus(null);
        return;
      }
      if (live && value?.documentId === documentId) setStatus(value);
    });
    update();
    const timer = setInterval(update, 750);
    return () => {
      live = false;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [documentId, slideId]);
  if (!status || status.documentId !== documentId) return null;
  const label =
    status.state === "ready"
      ? "Ready to present"
      : status.state === "failed"
        ? `Image preparation failed · ${status.failures.length} images`
        : `Preparing images · ${status.completed}/${status.total}`;
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="readiness-indicator"
        data-state={status.state}
        aria-expanded={details}
        aria-label={label}
        onClick={() => setDetails(!details)}
        title={`${label}. Static presentation images for ${status.profile.width} × ${status.profile.height} display pixels. Media and fonts prepare separately.`}
        style={{
          color:
            status.state === "ready"
              ? "#65bc85"
              : status.state === "failed"
                ? "#ef7777"
                : "#e4b85a",
        }}
      >
        {status.state === "ready" && (
          <span className="readiness-dot" aria-hidden="true" />
        )}
        <span
          className={
            status.state === "ready" ? "readiness-label-hidden" : undefined
          }
          aria-live="polite"
          aria-atomic="true"
        >
          {label}
        </span>
      </button>
      {details && (
        <div
          role="dialog"
          aria-label="Image preparation"
          className="readiness-details"
        >
          <p>
            {status.completed} of {status.total} image requirements prepared for{" "}
            {status.profile.width} × {status.profile.height} display pixels.
          </p>
          {status.failures.map((failure, index) => (
            <p key={index}>
              Affected slides:{" "}
              {failure.slideIds
                .map((id) => slideIds.indexOf(id) + 1)
                .filter((index) => index > 0)
                .join(", ") || "Presentation"}
              .{" "}
              {/sample depth|precision/i.test(failure.message)
                ? "This image's precision cannot be preserved on this platform."
                : /hash mismatch/i.test(failure.message)
                  ? "The original image no longer matches the imported asset."
                  : "The image could not be prepared. Check that its source and storage are available."}
            </p>
          ))}
          {status.state === "failed" && (
            <button
              type="button"
              onClick={() =>
                void platform.imageReadiness?.(documentId, true).then(setStatus)
              }
            >
              Retry image preparation
            </button>
          )}
          <button type="button" onClick={() => setDetails(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
