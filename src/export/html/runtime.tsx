import { createRoot } from "react-dom/client";
import { HtmlPresentationApp } from "./HtmlPresentationApp";
import type { HtmlExportPayload } from "./types";
import "./runtime.css";

function decodePayload(value: string): HtmlExportPayload {
  const payload = JSON.parse(value) as Partial<HtmlExportPayload>;
  if (
    payload.kind !== "showme-html-export" ||
    payload.formatVersion !== 1 ||
    !payload.document ||
    !Array.isArray(payload.assets) ||
    !Array.isArray(payload.fonts)
  )
    throw new Error("Unsupported or invalid ShowMe HTML export");
  return payload as HtmlExportPayload;
}

function boot() {
  const root = document.getElementById("root");
  const payloadNode = document.getElementById("showme-html-payload");
  if (!root || !payloadNode)
    throw new Error("ShowMe HTML export shell is incomplete");
  const payload = decodePayload(payloadNode.textContent ?? "");
  createRoot(root).render(<HtmlPresentationApp payload={payload} />);
}

try {
  boot();
} catch (cause) {
  const root = document.getElementById("root");
  if (root) {
    root.textContent = `Unable to open this ShowMe export: ${String(cause)}`;
    root.style.cssText =
      "box-sizing:border-box;padding:24px;color:#fff;background:#111;font:14px/1.5 monospace;min-height:100vh";
  }
}
