import * as pool from "../../src/components/preparedVideoPool";
import { platform } from "../../src/platform";
import { newPresentationDocument } from "../../src/core/document";
import { createMediaElement } from "../../src/core/media";
import { SlideRenderer } from "../../src/components/SlideRenderer";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { flushSync } from "react-dom";
async function waitForVideo(host: HTMLElement) {
  const deadline = performance.now() + 3000;
  while (
    (!host.querySelector("video") ||
      host.querySelector("video")!.readyState < 2) &&
    performance.now() < deadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (!host.querySelector("video"))
    throw new Error("Video did not mount: " + host.innerHTML);
}
export async function exerciseVideoWarmup() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  canvas.getContext("2d")!.fillStyle = "red";
  canvas.getContext("2d")!.fillRect(0, 0, 64, 64);
  const stream = canvas.captureStream(20),
    recorder = new MediaRecorder(stream, { mimeType: "video/webm" }),
    chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const animation = setInterval(() => {
    const context = canvas.getContext("2d")!;
    context.fillStyle = `rgb(${Math.floor(performance.now()) % 255},0,0)`;
    context.fillRect(0, 0, 64, 64);
  }, 40);
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  clearInterval(animation);
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((track) => track.stop());
  const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
  let urlCalls = 0;
  platform.assetUrl = async (_id, preview) => {
    urlCalls++;
    return preview ? null : url;
  };
  // The fixture shares one URL; production supplies an independently owned URL.
  platform.releaseUrl = () => {};
  const model = newPresentationDocument("Video"),
    slide = model.slides[model.deck.slideIds[0]];
  const element = createMediaElement("video", {
    version: 1,
    id: "a".repeat(64),
    filename: "clip.webm",
    names: ["clip.webm"],
    type: "video",
    mediaType: "video",
    mime: "video/webm",
    bytes: 1,
    width: 64,
    height: 64,
    duration: 0.5,
    createdAt: "2026-10-11T00:00:00Z",
  });
  if (element.content?.type !== "video") throw new Error("Video required");
  element.content.startTime = 0.1;
  element.content.mute = true;
  element.content.volume = 0.25;
  element.content.autoplay = false;
  slide.nodes[0].children = [element];
  const key = pool.videoPlayerKey(model.documentId, slide.id, element.id);
  document.body.replaceChildren();
  await pool.warmVideoPlayer(key, element.content, () => true, platform);
  const unrelated = document.querySelectorAll(".slide-renderer").length;
  const warmed = pool.acquireVideoPlayer(key, element.content.assetId, platform),
    player = warmed.node;
  const readyBefore = player.readyState;
  if (readyBefore < 2)
    throw new Error(
      "Warmup failed: " +
        JSON.stringify({
          urlCalls,
          src: player.src,
          error: player.error?.message,
          readyBefore,
        }),
    );
  warmed.release();
  let reloads = 0;
  const load = player.load.bind(player);
  player.load = () => {
    reloads++;
    load();
  };
  const host = document.createElement("main");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      createElement(SlideRenderer, {
        slide,
        deck: model.deck,
        presentation: true,
        preparedImages: true,
        renderScale: 0.25,
      }),
    ),
  );
  try {
    await waitForVideo(host);
  } catch (error) {
    throw new Error(
      String(error) +
        " pool=" +
        JSON.stringify({
          src: player.src,
          ready: player.readyState,
          error: player.error?.message,
          reloads,
        }),
      { cause: error },
    );
  }
  const active = host.querySelector("video")!;
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  const samePlayer = active === player,
    source = active.currentSrc;
  await active.play();
  await new Promise((resolve) => setTimeout(resolve, 80));
  active.pause();
  const paused = active.paused,
    volume = active.volume,
    muted = active.muted;
  flushSync(() => root.render(null));
  flushSync(() =>
    root.render(
      createElement(SlideRenderer, {
        slide,
        deck: model.deck,
        presentation: true,
        preparedImages: true,
        renderScale: 0.25,
      }),
    ),
  );
  await waitForVideo(host);
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  const backward = host.querySelector("video")!;
  const replay = {
    same: backward === player,
    start: backward.currentTime,
    source: backward.currentSrc === source,
  };
  const reloadsBeforeDisposal = reloads;
  root.unmount();
  pool.cancelVideoWarmup(new Set());
  URL.revokeObjectURL(url);
  return {
    unrelated,
    readyBefore,
    samePlayer,
    reloadsBeforeDisposal,
    volume,
    muted,
    paused,
    replay,
  };
}
