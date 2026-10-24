import type { RenderResources } from "../core/renderResources";
import type { Element } from "../core/element";
import { videoBounds } from "../core/video";

type VideoContent = Extract<NonNullable<Element["content"]>, { type: "video" }>;
interface Player {
  node: HTMLVideoElement;
  url: string | null;
  owners: number;
  assetId: string;
  resources: RenderResources;
}
const players = new Map<string, Player>();
export function videoPlayerKey(
  documentId: string,
  slideId: string,
  elementId: string,
) {
  return documentId + ":" + slideId + ":" + elementId;
}
function trimPool() {
  for (const [key, player] of players) {
    if (players.size <= 12) break;
    if (player.owners) continue;
    discard(key, player);
  }
}
function discard(key: string, player: Player) {
  player.node.pause();
  player.node.removeAttribute("src");
  player.node.load();
  player.node.remove();
  if (player.url) player.resources.releaseUrl(player.url);
  if (players.get(key) === player) players.delete(key);
}
export function acquireVideoPlayer(
  key: string,
  assetId: string,
  resources: RenderResources,
) {
  let player = players.get(key);
  if (
    player &&
    (player.assetId !== assetId || player.resources !== resources) &&
    !player.owners
  ) {
    discard(key, player);
    player = undefined;
  }
  if (!player || player.owners) {
    const node = document.createElement("video");
    node.crossOrigin = "anonymous";
    node.playsInline = true;
    node.preload = "auto";
    player = { node, url: null, owners: 0, assetId, resources };
    // A second concurrent surface must own its own player.
    if (!players.get(key)?.owners) players.set(key, player);
  }
  player.owners++;
  trimPool();
  return {
    node: player.node,
    release() {
      player!.owners--;
      player!.node.pause();
      player!.node.remove();
      if (!player!.url) {
        player!.node.removeAttribute("src");
        player!.node.load();
      }
      if (players.get(key) !== player) discard(key + ":unshared", player!);
      trimPool();
    },
  };
}
export async function warmVideoPlayer(
  key: string,
  content: VideoContent,
  live: () => boolean,
  resources: RenderResources,
) {
  const existing = players.get(key);
  if (
    existing?.resources === resources &&
    existing.assetId === content.assetId &&
    (existing.owners || (existing.url && existing.node.readyState >= 2))
  )
    return;
  const handle = acquireVideoPlayer(key, content.assetId, resources);
  const player = players.get(key)!;
  handle.release();
  try {
    const url = await resources.assetUrl(content.assetId);
    if (!url) return;
    if (!live() || player.owners || players.get(key) !== player) {
      resources.releaseUrl(url);
      return;
    }
    player.url = url;
    const node = handle.node;
    node.muted = content.mute;
    node.volume = content.volume;
    await new Promise<void>((resolve) => {
      const ready = () => {
        if (!live() || player.owners) {
          finish();
          return;
        }
        const { start } = videoBounds(content, node.duration);
        if (Math.abs(node.currentTime - start) > 0.001) {
          node.currentTime = start;
          return;
        }
        if (node.readyState >= 2 && !node.seeking) finish();
      };
      const finish = () => {
        clearTimeout(timer);
        node.removeEventListener("loadedmetadata", ready);
        node.removeEventListener("loadeddata", ready);
        node.removeEventListener("seeked", ready);
        node.removeEventListener("error", finish);
        resolve();
      };
      const timer = setTimeout(finish, 4000);
      node.addEventListener("loadedmetadata", ready);
      node.addEventListener("loadeddata", ready);
      node.addEventListener("seeked", ready);
      node.addEventListener("error", finish);
      node.src = url;
      node.load();
    });
  } finally {
    if (!live() && !player.owners) discard(key, player);
  }
}
export function cancelVideoWarmup(
  keep: ReadonlySet<string>,
  slidePrefixes: readonly string[] = [],
) {
  for (const [key, player] of players)
    if (
      !player.owners &&
      !keep.has(key) &&
      !slidePrefixes.some((prefix) => key.startsWith(prefix))
    )
      discard(key, player);
}

/** Drop idle players before their provider revokes its URLs. */
export function releasePreparedVideos(resources: RenderResources) {
  for (const [key, player] of players)
    if (player.resources === resources && !player.owners) discard(key, player);
}
