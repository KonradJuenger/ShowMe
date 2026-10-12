import { useEffect, useState } from "react";
import { platform } from "../platform";
import type { PresenterState } from "../platform/api";
import { subscribeToPresentation } from "../platform/presentationSubscription";

export function usePresentationState(onError: (error: unknown) => void) {
  const [state, setState] = useState<PresenterState | null>(null);
  useEffect(
    () => subscribeToPresentation(platform, setState, onError),
    [onError],
  );
  return state;
}
