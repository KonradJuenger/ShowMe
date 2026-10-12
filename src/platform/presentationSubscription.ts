import type { Platform, PresenterState } from "./api";

/** Live events take precedence over an older asynchronous initial read. */
export function subscribeToPresentation(
  api: Pick<Platform, "getPresentation" | "onPresentation">,
  receive: (state: PresenterState | null) => void,
  onError: (error: unknown) => void,
) {
  let live = true;
  let receivedEvent = false;
  const unsubscribe = api.onPresentation((state) => {
    receivedEvent = true;
    if (live) receive(state);
  });
  void api
    .getPresentation()
    .then((state) => {
      if (live && !receivedEvent) receive(state);
    })
    .catch((error) => {
      if (live && !receivedEvent) onError(error);
    });
  return () => {
    live = false;
    unsubscribe();
  };
}
