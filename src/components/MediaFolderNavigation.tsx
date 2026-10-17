import { useLayoutEffect, useRef } from "react";
import { IconChevronRight } from "./AppIcons";

export function MediaFolderNavigation({
  rootLabel,
  folder,
  onNavigate,
}: {
  rootLabel: string;
  folder: string;
  onNavigate: (folder: string) => void;
}) {
  const breadcrumbs = useRef<HTMLOListElement>(null);
  const parts = folder.split("/");
  useLayoutEffect(() => {
    if (breadcrumbs.current)
      breadcrumbs.current.scrollLeft = breadcrumbs.current.scrollWidth;
  }, [folder]);
  return (
    <nav className="native-library-breadcrumbs" aria-label="Current folder">
      <ol ref={breadcrumbs}>
        <li>
          <button type="button" onClick={() => onNavigate("")}>
            {rootLabel}
          </button>
        </li>
        {parts.map((part, index) => (
          <li key={parts.slice(0, index + 1).join("/")}>
            <IconChevronRight aria-hidden="true" />
            <button
              type="button"
              aria-label={part}
              title={part}
              aria-current={index === parts.length - 1 ? "location" : undefined}
              onClick={() => onNavigate(parts.slice(0, index + 1).join("/"))}
            >
              {part}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
