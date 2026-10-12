import type {
  CommandId,
  ContextMenuCommandDescriptor,
  ContextMenuItemDescriptor,
  ContextMenuSeparatorDescriptor,
} from "../core/commandRegistry";

export type ContextMenuCommandItem = ContextMenuCommandDescriptor & {
  value?: string;
};
export interface ContextMenuSubmenuDescriptor {
  type: "submenu";
  label: string;
  enabled: boolean;
  items: Array<ContextMenuCommandItem | ContextMenuSeparatorDescriptor>;
}
export type ContextMenuRequestItem =
  | ContextMenuCommandItem
  | ContextMenuSeparatorDescriptor
  | ContextMenuSubmenuDescriptor;

export interface ContextMenuSelection {
  commandId: CommandId;
  value?: string;
}

export interface ContextMenuRequest {
  items: ContextMenuRequestItem[];
  x: number;
  y: number;
}

let dismiss: (() => void) | null = null;
let generation = 0;
let suppressedUntil = 0;

export function suppressContextMenuTemporarily(duration = 500) {
  suppressedUntil = Date.now() + duration;
  closeContextMenu();
}

export function clearContextMenuSuppression() {
  suppressedUntil = 0;
}

export function isContextMenuSuppressed() {
  return Date.now() < suppressedUntil;
}

export function isContextMenuOpen() {
  return document.body.dataset.contextMenuOpen === "true";
}
export function closeContextMenu() {
  generation++;
  dismiss?.();
  dismiss = null;
  delete document.body.dataset.contextMenuOpen;
  void window.desktop?.closeContextMenu?.();
}

export async function showContextMenuSelection(request: ContextMenuRequest) {
  closeContextMenu();
  const token = generation;
  document.body.dataset.contextMenuOpen = "true";
  try {
    const selection = await (window.desktop?.showContextMenu
      ? window.desktop.showContextMenu(request)
      : showBrowserContextMenu(request));
    return token === generation ? selection : null;
  } finally {
    if (token === generation) delete document.body.dataset.contextMenuOpen;
  }
}

/** Existing menu callers only need a command ID. */
export async function showContextMenu(request: ContextMenuRequest) {
  return (await showContextMenuSelection(request))?.commandId ?? null;
}

export function showBrowserContextMenu(request: ContextMenuRequest) {
  return new Promise<ContextMenuSelection | null>((resolve) => {
    dismiss?.();
    const previousFocus = document.activeElement as HTMLElement | null;
    const menu = document.createElement("div");
    menu.dataset.showmeContextMenu = "true";
    menu.className = "showme-context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Context menu");
    Object.assign(menu.style, {
      position: "fixed",
      left: request.x + "px",
      top: request.y + "px",
      minWidth: "190px",
      padding: "5px",
      border: "1px solid rgba(0,0,0,.18)",
      borderRadius: "8px",
      background: "rgba(250,250,249,.98)",
      boxShadow: "0 10px 30px rgba(0,0,0,.18)",
      zIndex: "2147483647",
    });

    let settled = false;
    const finish = (value: ContextMenuSelection | null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keydown, true);
      menu.remove();
      dismiss = null;
      if (previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true });
      resolve(value);
    };
    const enabledButtons = () =>
      Array.from(
        menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      ).filter((button) => button.getClientRects().length > 0);
    const outside = (event: Event) => {
      if (!menu.contains(event.target as Node)) finish(null);
    };
    const keydown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation();
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        finish(null);
        return;
      }
      const buttons = enabledButtons();
      if (!buttons.length) return;
      const active = document.activeElement as HTMLButtonElement | null;
      const index = buttons.indexOf(active!);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        buttons[(index + delta + buttons.length) % buttons.length]?.focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
      } else if ((event.key === "Enter" || event.key === " ") && index >= 0) {
        event.preventDefault();
        active?.click();
      }
    };

    const separator = () => {
      const node = document.createElement("div");
      node.setAttribute("role", "separator");
      Object.assign(node.style, {
        height: "1px",
        margin: "4px 3px",
        background: "rgba(0,0,0,.12)",
      });
      return node;
    };
    const commandButton = (
      item: ContextMenuCommandItem,
      nested = false,
    ) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.dataset.commandId = item.commandId;
      if (item.value !== undefined) button.dataset.commandValue = item.value;
      button.textContent = item.label;
      button.disabled = !item.enabled;
      if (item.accelerator) button.title = item.accelerator;
      Object.assign(button.style, {
        width: "100%",
        display: "block",
        border: "0",
        borderRadius: "5px",
        padding: nested ? "6px 12px" : "6px 9px",
        background: "transparent",
        textAlign: "left",
        font: "inherit",
        color: item.enabled ? "inherit" : "rgba(0,0,0,.38)",
      });
      button.addEventListener(
        "mouseenter",
        () => item.enabled && button.focus(),
      );
      button.addEventListener("click", () =>
        finish({
          commandId: item.commandId,
          ...(item.value === undefined ? {} : { value: item.value }),
        }),
      );
      return button;
    };
    const closeSubmenus = (except?: HTMLElement) => {
      for (const child of menu.querySelectorAll<HTMLElement>(
        "[data-context-submenu]",
      ))
        if (child !== except) child.hidden = true;
      for (const button of menu.querySelectorAll<HTMLButtonElement>(
        "[aria-haspopup=menu]",
      ))
        button.setAttribute(
          "aria-expanded",
          String(
            !!button.parentElement?.querySelector<HTMLElement>(
              ":scope > [data-context-submenu]:not([hidden])",
            ),
          ),
        );
    };

    for (const item of request.items) {
      if (item.type === "separator") {
        menu.appendChild(separator());
        continue;
      }
      if (item.type === "command") {
        menu.appendChild(commandButton(item));
        continue;
      }
      const wrapper = document.createElement("div");
      Object.assign(wrapper.style, { position: "relative" });
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.textContent = item.label + " ›";
      button.disabled = !item.enabled;
      Object.assign(button.style, {
        width: "100%",
        display: "block",
        border: "0",
        borderRadius: "5px",
        padding: "6px 9px",
        background: "transparent",
        textAlign: "left",
        font: "inherit",
        color: item.enabled ? "inherit" : "rgba(0,0,0,.38)",
      });
      const child = document.createElement("div");
      child.dataset.contextSubmenu = "true";
      child.hidden = true;
      child.setAttribute("role", "menu");
      child.setAttribute("aria-label", item.label);
      Object.assign(child.style, {
        position: "absolute",
        left: "calc(100% - 2px)",
        top: "-5px",
        minWidth: "190px",
        padding: "5px",
        border: "1px solid rgba(0,0,0,.18)",
        borderRadius: "8px",
        background: "rgba(250,250,249,.98)",
        boxShadow: "0 10px 30px rgba(0,0,0,.18)",
      });
      for (const nested of item.items)
        child.appendChild(
          nested.type === "separator"
            ? separator()
            : commandButton(nested, true),
        );
      const open = () => {
        if (!item.enabled) return;
        closeSubmenus(child);
        child.hidden = false;
        button.setAttribute("aria-expanded", "true");
      };
      button.addEventListener("mouseenter", open);
      button.addEventListener("focus", open);
      button.addEventListener("click", () => {
        if (child.hidden) open();
        else {
          child.hidden = true;
          button.setAttribute("aria-expanded", "false");
        }
      });
      wrapper.addEventListener("mouseleave", () => {
        child.hidden = true;
        button.setAttribute("aria-expanded", "false");
      });
      wrapper.append(button, child);
      menu.appendChild(wrapper);
    }

    dismiss = () => finish(null);
    menu.style.maxHeight = `${window.innerHeight - 8}px`;
    menu.style.overflowY = "auto";
    menu.addEventListener("pointerdown", (event) => event.preventDefault());
    document.body.appendChild(menu);
    const bounds = menu.getBoundingClientRect();
    menu.style.left =
      Math.max(4, Math.min(request.x, window.innerWidth - bounds.width - 4)) +
      "px";
    menu.style.top =
      Math.max(4, Math.min(request.y, window.innerHeight - bounds.height - 4)) +
      "px";
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keydown, true);
    enabledButtons()[0]?.focus();
  });
}

export type { ContextMenuItemDescriptor };
