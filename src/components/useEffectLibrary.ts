import { useEffect, useState } from "react";
import { platform } from "../platform";
import type {
  EffectLibrary,
  EffectLibraryRequest,
} from "../core/libraryEffects";

const changedEvent = "showme-effect-library-changed";

/** All library mutations notify both sidebar and Media library consumers. */
export async function requestEffectLibrary(request: EffectLibraryRequest) {
  if (!platform.effectLibrary) throw new Error("Effect Library is unavailable");
  try {
    return await platform.effectLibrary(request);
  } finally {
    if (request.type !== "list" && request.type !== "reveal")
      window.dispatchEvent(new Event(changedEvent));
  }
}

export function useEffectLibrary() {
  const [library, setLibrary] = useState<EffectLibrary>({
    entries: [],
    folders: [],
  });
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void requestEffectLibrary({ type: "list" })
        .then((next) => {
          if (active && current === generation) {
            setLibrary(next);
            setError("");
          }
        })
        .catch((failure) => {
          if (active && current === generation) setError(String(failure));
        });
    };
    refresh();
    window.addEventListener(changedEvent, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener(changedEvent, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return { library, error };
}
