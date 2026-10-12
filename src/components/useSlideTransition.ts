import { useLayoutEffect, useState, type RefObject } from "react";
import type { SlideTransitionPlayback } from "../core/slideTransitions";

/** Native compositor playback follows the authority's shared presentation clock. */
export function useSlideTransition(
  root: RefObject<HTMLDivElement | null>,
  slideId: string,
  active: boolean,
  scale: number,
  transition?: SlideTransitionPlayback,
  pausedAt?: number,
) {
  const [finished, setFinished] = useState<number | undefined>();
  const startedAt = transition?.startedAt;
  const from = transition?.fromSlideId === slideId;
  const to = transition?.toSlideId === slideId;
  const duration = transition?.durationMs ?? 0;
  const kind = transition?.kind;
  const easing = transition?.easing;
  const outgoing = from && (startedAt === undefined || finished !== startedAt);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || (!from && !to) || startedAt === undefined || !duration) return;
    const elapsed = Math.max(0, (pausedAt ?? Date.now()) - startedAt);
    if (elapsed >= duration) {
      setFinished(startedAt);
      return;
    }
    const transform = `scale(${scale})`;
    let frames: Keyframe[];
    if (kind === "push")
      frames = from
        ? [{ transform }, { transform: `${transform} translateX(-100%)` }]
        : [{ transform: `${transform} translateX(100%)` }, { transform }];
    else if (kind === "wipe" && to)
      frames = [
        { clipPath: "inset(0 100% 0 0)" },
        { clipPath: "inset(0 0 0 0)" },
      ];
    else if (kind === "fade" && to) frames = [{ opacity: 0 }, { opacity: 1 }];
    else frames = [{ opacity: 1 }, { opacity: 1 }];
    const animation = node.animate(frames, { duration, easing, fill: "both" });
    animation.currentTime = elapsed;
    if (pausedAt !== undefined) animation.pause();
    animation.onfinish = () => {
      setFinished(startedAt);
      animation.cancel();
    };
    return () => {
      animation.onfinish = null;
      animation.cancel();
    };
  }, [root, from, to, startedAt, duration, kind, easing, scale, pausedAt]);
  return {
    visible: active || outgoing,
    outgoing,
    preparing: to && startedAt === undefined,
  };
}
