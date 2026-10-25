import { useEffect, type RefObject } from "react";
import { flushEffectSurfaces } from "./effectRuntime";
import type { PresenterState } from "../platform/api";
import type { PresentationCommand } from "../core/presentationSession";

/** Release canonical clocks only after decoded media and asynchronous Effects paint. */
export function useAudienceReady(
  root: RefObject<HTMLElement | null>,
  slideId: string,
  state: PresenterState | null,
  ready: boolean,
  onPrepared: (id: string) => void,
  sendReady: (command: PresentationCommand) => void | Promise<unknown>,
  onError: (cause: unknown) => void,
) {
  const sessionStartedAt = state?.startedAt;
  const motionStartedAt = state?.motion?.startedAt ?? state?.slideStartedAt;
  useEffect(() => {
    if (
      !ready ||
      sessionStartedAt === undefined ||
      motionStartedAt === undefined
    )
      return;
    let live = true;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void (async () => {
          if (root.current && !(await flushEffectSurfaces(root.current))) {
            onError(new Error("Effect output is not ready for presentation"));
            return;
          }
          if (live) onPrepared(slideId);
          if (live)
            void Promise.resolve(
              sendReady({
                type: "audience-ready",
                slideId: slideId,
                sessionStartedAt,
                motionStartedAt,
              }),
            ).catch(onError);
        })().catch(onError);
      });
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, [
    root,
    ready,
    sessionStartedAt,
    motionStartedAt,
    slideId,
    onError,
    onPrepared,
    sendReady,
  ]);
}
