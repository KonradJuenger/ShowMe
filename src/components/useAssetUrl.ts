import { useEffect, useState } from "react";
import { useRenderResources } from "./renderResources";

export function useAssetUrl(id: string, preview = false, enabled = true) {
  const resources = useRenderResources();
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
      resources
        .assetUrl(id, preview)
        .then((u) => {
          if (!live) {
            if (u) resources.releaseUrl(u);
            return;
          }
          if (current && current !== u) {
            resources.releaseUrl(current);
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
      if (current) resources.releaseUrl(current);
    };
  }, [id, preview, enabled, resources]);
  return url;
}
