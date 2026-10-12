import { useEffect, useState } from "react";
import { platform } from "../platform";

export function useAssetUrl(id: string, preview = false, enabled = true) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) {
      setUrl(undefined);
      return;
    }
    let live = true,
      current: string | null = null,
      retryTimer: ReturnType<typeof setTimeout> | undefined;
    const fetchUrl = () => {
      platform
        .assetUrl(id, preview)
        .then((u) => {
          if (!live) {
            if (u) platform.releaseUrl(u);
            return;
          }
          if (current && current !== u) {
            platform.releaseUrl(current);
          }
          current = u;
          setUrl(u);
          if (u === null) {
            retryTimer = setTimeout(fetchUrl, 3000);
          }
        })
        .catch(() => {
          if (!live) return;
          setUrl(null);
          retryTimer = setTimeout(fetchUrl, 3000);
        });
    };
    setUrl(undefined);
    fetchUrl();
    return () => {
      live = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (current) platform.releaseUrl(current);
    };
  }, [id, preview, enabled]);
  return url;
}
