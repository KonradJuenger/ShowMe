import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconFolder,
} from "./AppIcons";

export function MediaFolderNavigation({
  category,
  rootLabel,
  folder,
  folders,
  onNavigate,
  onBrowse,
}: {
  category: string;
  rootLabel: string;
  folder: string;
  folders: string[];
  onNavigate: (folder: string) => void;
  onBrowse: () => void;
}) {
  const picker = useRef<HTMLDetailsElement>(null);
  const breadcrumbs = useRef<HTMLOListElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const parts = folder ? folder.split("/") : [];
  const children = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const fullPath of folders) {
      if (!fullPath.startsWith(category + "/")) continue;
      const path = fullPath.slice(category.length + 1);
      const parent = path.split("/").slice(0, -1).join("/");
      const siblings = result.get(parent) ?? [];
      siblings.push(path);
      result.set(parent, siblings);
    }
    for (const siblings of result.values()) {
      siblings.sort((a, b) =>
        a
          .split("/")
          .at(-1)!
          .localeCompare(b.split("/").at(-1)!, undefined, { numeric: true }),
      );
    }
    return result;
  }, [category, folders]);

  useEffect(() => {
    setExpanded((before) => {
      const next = new Set(before);
      const ancestors = folder.split("/");
      for (let index = 1; index <= ancestors.length; index++)
        next.add(ancestors.slice(0, index).join("/"));
      return next;
    });
  }, [category, folder]);

  useLayoutEffect(() => {
    if (breadcrumbs.current)
      breadcrumbs.current.scrollLeft = breadcrumbs.current.scrollWidth;
  }, [folder]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (picker.current && !picker.current.contains(event.target as Node))
        picker.current.open = false;
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  const navigate = (path: string) => {
    if (picker.current) picker.current.open = false;
    onNavigate(path);
    picker.current?.querySelector("summary")?.focus();
  };

  const renderFolders = (parent: string) => (
    <ul>
      {(children.get(parent) ?? []).map((path) => {
        const name = path.split("/").at(-1)!;
        const label = path.split("/").join(" / ");
        const hasChildren = children.has(path);
        const open = expanded.has(path);
        return (
          <li key={path}>
            <div
              className={`native-library-folder-row${folder === path ? " is-current" : ""}`}
            >
              {hasChildren ? (
                <button
                  type="button"
                  className="native-library-folder-disclosure"
                  aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
                  aria-expanded={open}
                  onClick={() =>
                    setExpanded((before) => {
                      const next = new Set(before);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })
                  }
                >
                  <IconChevronRight aria-hidden="true" />
                </button>
              ) : (
                <span
                  className="native-library-folder-leaf"
                  aria-hidden="true"
                />
              )}
              <button
                type="button"
                className="native-library-folder-link"
                aria-label={`Open folder ${label}`}
                aria-current={folder === path ? "location" : undefined}
                title={label}
                onClick={() => navigate(path)}
              >
                <IconFolder aria-hidden="true" />
                <span>{name}</span>
              </button>
            </div>
            {hasChildren && open && renderFolders(path)}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="native-library-folder-navigation">
      <button
        type="button"
        className="native-library-up"
        aria-label="Up one folder"
        title="Up one folder"
        disabled={!folder}
        onClick={() => onNavigate(parts.slice(0, -1).join("/"))}
      >
        <IconChevronLeft aria-hidden="true" />
      </button>
      <nav className="native-library-breadcrumbs" aria-label="Current folder">
        <ol ref={breadcrumbs}>
          <li>
            <button
              type="button"
              aria-current={!folder ? "location" : undefined}
              onClick={() => onNavigate("")}
            >
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
                aria-current={
                  index === parts.length - 1 ? "location" : undefined
                }
                onClick={() => onNavigate(parts.slice(0, index + 1).join("/"))}
              >
                {part}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <details
        className="native-library-folder-picker"
        ref={picker}
        onKeyDown={(event) => {
          if (event.key === "Escape" && picker.current?.open) {
            event.stopPropagation();
            picker.current.open = false;
            picker.current.querySelector("summary")?.focus();
          }
        }}
      >
        <summary
          aria-label="Browse folders"
          title="Browse folders"
          onClick={onBrowse}
        >
          <IconFolder aria-hidden="true" />
          <IconChevronDown aria-hidden="true" />
        </summary>
        <nav
          className="native-library-folder-tree"
          aria-label="Folder hierarchy"
        >
          <button
            type="button"
            className="native-library-folder-root"
            aria-current={!folder ? "location" : undefined}
            onClick={() => navigate("")}
          >
            <IconFolder aria-hidden="true" />
            {rootLabel}
          </button>
          {renderFolders("")}
          {!children.has("") && <p>No folders yet</p>}
        </nav>
      </details>
    </div>
  );
}
