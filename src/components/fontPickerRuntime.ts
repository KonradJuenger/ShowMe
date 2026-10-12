import type { SystemFontFamily } from "../platform/api";

const ENHANCED = "systemFontPicker";
const FONT_INPUT_SELECTOR = 'input[aria-label="Font family"]';
const weightLabels = new Map([
  [100, "Thin (100)"],
  [200, "Extra Light (200)"],
  [300, "Light (300)"],
  [400, "Regular (400)"],
  [500, "Medium (500)"],
  [600, "Semibold (600)"],
  [700, "Bold (700)"],
  [800, "Extra Bold (800)"],
  [900, "Black (900)"],
]);
let listboxSequence = 0;

function sameNumbers(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

function exactFamily(
  families: readonly SystemFontFamily[],
  value: string,
): SystemFontFamily | undefined {
  const normalized = value.trim().toLocaleLowerCase();
  return families.find(
    (item) => item.family.toLocaleLowerCase() === normalized,
  );
}

function replaceWeightOptions(
  input: HTMLInputElement,
  families: readonly SystemFontFamily[],
) {
  const section = input.closest(".km-section");
  const select = section?.querySelector<HTMLSelectElement>(
    'select[aria-label="Font weight"]',
  );
  if (!select) return;
  const family = exactFamily(families, input.value);
  if (!family) return;
  const current = Number(select.value);
  const weights = Array.from(
    new Set([
      ...family.weights,
      ...(Number.isFinite(current) ? [current] : []),
    ]),
  ).sort((a, b) => a - b);
  const existing = Array.from(select.options, (option) => Number(option.value));
  if (sameNumbers(existing, weights)) return;
  const fragment = document.createDocumentFragment();
  for (const weight of weights) {
    const option = document.createElement("option");
    option.value = String(weight);
    option.textContent = `${weightLabels.get(weight) ?? `Weight ${weight}`}${family.weights.includes(weight) ? "" : " (unavailable)"}`;
    fragment.append(option);
  }
  select.replaceChildren(fragment);
  if (Number.isFinite(current)) select.value = String(current);
}

function fontInput(target: EventTarget | null): HTMLInputElement | null {
  return target instanceof HTMLInputElement &&
    target.matches(FONT_INPUT_SELECTOR)
    ? target
    : null;
}

function styleListbox(listbox: HTMLDivElement) {
  Object.assign(listbox.style, {
    position: "absolute",
    left: "0",
    right: "0",
    top: "calc(100% + 4px)",
    zIndex: "80",
    display: "none",
    maxHeight: "240px",
    overflowY: "auto",
    padding: "4px",
    border: "1px solid var(--km-border-subtle)",
    borderRadius: "var(--km-radius-md)",
    background: "var(--km-bg-surface)",
    boxShadow: "var(--km-shadow-lg)",
  });
}

function styleOption(
  option: HTMLDivElement,
  selected: boolean,
  active: boolean,
) {
  Object.assign(option.style, {
    minHeight: "28px",
    display: "flex",
    alignItems: "center",
    padding: "4px 8px",
    borderRadius: "var(--km-radius-sm)",
    color: "var(--km-text-primary)",
    background: active
      ? "var(--km-bg-hover)"
      : selected
        ? "var(--km-bg-subtle)"
        : "transparent",
    fontSize: "12px",
    fontWeight: selected ? "600" : "400",
    cursor: "default",
    userSelect: "none",
  });
}

export function installFontPickerRuntime(
  loadFonts: () => Promise<SystemFontFamily[]>,
) {
  let fontPromise: Promise<SystemFontFamily[]> | null = null;
  let families: SystemFontFamily[] = [];

  const ensureFonts = () => {
    fontPromise ??= loadFonts().then((items) => {
      families = items;
      return items;
    });
    return fontPromise;
  };

  const enhance = (input: HTMLInputElement) => {
    if (input.dataset[ENHANCED]) return;
    input.dataset[ENHANCED] = "true";

    const parent = input.parentElement;
    if (!parent) return;

    // A native datalist treats the input's current value as an active filter.
    // The picker needs the current value to be a selection, not a query.
    input.removeAttribute("list");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");

    const listbox = document.createElement("div");
    const listboxId = `showme-font-listbox-${++listboxSequence}`;
    listbox.id = listboxId;
    listbox.setAttribute("role", "listbox");
    listbox.setAttribute("aria-label", "Font families");
    styleListbox(listbox);
    // Keep the menu anchored to the font field in every inspector host.
    parent.style.position = "relative";
    parent.append(listbox);
    input.setAttribute("aria-controls", listboxId);

    let lastValid = input.value;
    let searchQuery = "";
    let visibleFamilies: SystemFontFamily[] = [];
    let activeIndex = -1;
    let isOpen = false;
    let fontsLoaded = false;
    let dispatchingCanonical = false;

    const setActive = (index: number, scroll = true) => {
      if (!visibleFamilies.length) {
        activeIndex = -1;
        input.removeAttribute("aria-activedescendant");
        return;
      }
      activeIndex = Math.max(0, Math.min(index, visibleFamilies.length - 1));
      const options = Array.from(
        listbox.querySelectorAll<HTMLDivElement>('[role="option"]'),
      );
      options.forEach((option, optionIndex) => {
        const selected =
          option.dataset.family?.toLocaleLowerCase() ===
          lastValid.toLocaleLowerCase();
        styleOption(option, selected, optionIndex === activeIndex);
      });
      const active = options[activeIndex];
      if (!active) return;
      input.setAttribute("aria-activedescendant", active.id);
      if (scroll) active.scrollIntoView({ block: "nearest" });
    };

    const renderList = () => {
      if (!fontsLoaded) {
        const loading = document.createElement("div");
        loading.textContent = "Loading fonts…";
        Object.assign(loading.style, {
          padding: "8px",
          color: "var(--km-text-muted)",
          fontSize: "12px",
        });
        listbox.replaceChildren(loading);
        visibleFamilies = [];
        return;
      }

      const query = searchQuery.trim().toLocaleLowerCase();
      visibleFamilies = query
        ? families.filter((family) =>
            family.family.toLocaleLowerCase().includes(query),
          )
        : [...families];

      if (!visibleFamilies.length) {
        const empty = document.createElement("div");
        empty.textContent = "No matching fonts";
        Object.assign(empty.style, {
          padding: "8px",
          color: "var(--km-text-muted)",
          fontSize: "12px",
        });
        listbox.replaceChildren(empty);
        input.removeAttribute("aria-activedescendant");
        activeIndex = -1;
        return;
      }

      const fragment = document.createDocumentFragment();
      visibleFamilies.forEach((family, index) => {
        const option = document.createElement("div");
        option.id = `${listboxId}-option-${index}`;
        option.dataset.family = family.family;
        option.setAttribute("role", "option");
        const selected =
          family.family.toLocaleLowerCase() === lastValid.toLocaleLowerCase();
        option.setAttribute("aria-selected", String(selected));
        option.textContent = family.family;
        option.style.fontFamily = family.family;
        styleOption(option, selected, index === activeIndex);
        option.addEventListener("pointermove", () => setActive(index, false));
        option.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          commitCanonical(family);
          closeList(false);
          input.focus();
        });
        fragment.append(option);
      });
      listbox.replaceChildren(fragment);

      if (activeIndex < 0 || activeIndex >= visibleFamilies.length) {
        const selectedIndex = visibleFamilies.findIndex(
          (family) =>
            family.family.toLocaleLowerCase() === lastValid.toLocaleLowerCase(),
        );
        activeIndex = selectedIndex >= 0 ? selectedIndex : 0;
      }
      setActive(activeIndex);
    };

    const openList = () => {
      if (!isOpen) {
        const current = input.value.trim();
        if (current && current !== lastValid) lastValid = current;
        searchQuery = "";
        isOpen = true;
        listbox.style.display = "block";
        input.setAttribute("aria-expanded", "true");
        activeIndex = families.findIndex(
          (family) =>
            family.family.toLocaleLowerCase() === lastValid.toLocaleLowerCase(),
        );
      }
      renderList();
      queueMicrotask(() => {
        if (document.activeElement === input && !searchQuery) input.select();
      });
    };

    const closeList = (restore = true) => {
      if (restore) setNativeInputValue(input, lastValid);
      searchQuery = "";
      isOpen = false;
      activeIndex = -1;
      listbox.style.display = "none";
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    };

    const commitCanonical = (family: SystemFontFamily) => {
      lastValid = family.family;
      searchQuery = "";
      dispatchingCanonical = true;
      setNativeInputValue(input, family.family);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("showme-font-selected"));
      dispatchingCanonical = false;
      queueMicrotask(() => replaceWeightOptions(input, families));
    };

    void ensureFonts().then((items) => {
      const currentWeight = Number(
        input
          .closest(".km-section")
          ?.querySelector<HTMLSelectElement>('select[aria-label="Font weight"]')
          ?.value,
      );
      const current = input.value.trim() || lastValid;
      if (current && !exactFamily(items, current))
        items = [
          {
            family: current,
            weights: Number.isFinite(currentWeight) ? [currentWeight] : [400],
          },
          ...items,
        ];
      families = items;
      fontsLoaded = true;
      const match = exactFamily(items, input.value);
      if (match) {
        lastValid = match.family;
        replaceWeightOptions(input, items);
      } else {
        setNativeInputValue(input, lastValid);
        replaceWeightOptions(input, items);
      }
      if (isOpen) {
        activeIndex = items.findIndex(
          (family) =>
            family.family.toLocaleLowerCase() === lastValid.toLocaleLowerCase(),
        );
        renderList();
      }
    });

    input.addEventListener("pointerdown", () => openList());
    input.addEventListener("focus", () => openList());

    input.addEventListener("input", (event) => {
      if (dispatchingCanonical) return;
      if (!isOpen) openList();
      searchQuery = input.value;
      activeIndex = 0;
      renderList();

      // Typing is search only. The document changes after a list selection or
      // an explicit exact match, never while the user is narrowing the list.
      event.stopPropagation();
    });

    input.addEventListener("blur", () => {
      const match = exactFamily(families, input.value);
      if (match) {
        commitCanonical(match);
        closeList(false);
      } else {
        closeList(true);
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openList();
        setActive(activeIndex < 0 ? 0 : activeIndex + 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        openList();
        setActive(
          activeIndex < 0 ? visibleFamilies.length - 1 : activeIndex - 1,
        );
        return;
      }
      if (event.key === "Enter" && isOpen) {
        event.preventDefault();
        const family =
          exactFamily(families, input.value) ?? visibleFamilies[activeIndex];
        if (family) {
          commitCanonical(family);
          closeList(false);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeList(true);
        return;
      }
      if (event.key === "Tab" && isOpen) {
        const match = exactFamily(families, input.value);
        if (match) commitCanonical(match);
        closeList(!match);
        return;
      }

      const startsSearch =
        isOpen &&
        searchQuery === "" &&
        input.value === lastValid &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key.length === 1 ||
          event.key === "Backspace" ||
          event.key === "Delete");
      if (startsSearch) {
        setNativeInputValue(input, "");
        searchQuery = "";
        activeIndex = 0;
        renderList();
      }
    });
  };

  const activate = (event: Event) => {
    const input =
      fontInput(event.target) ??
      (event.target instanceof HTMLSelectElement &&
      event.target.matches('select[aria-label="Font weight"]')
        ? event.target
            .closest(".km-section")
            ?.querySelector<HTMLInputElement>(FONT_INPUT_SELECTOR)
        : null);
    if (input) enhance(input);
    if (input)
      void ensureFonts().then(() => replaceWeightOptions(input, families));
  };

  document.addEventListener("pointerdown", activate, true);
  document.addEventListener("focusin", activate, true);
  return () => {
    document.removeEventListener("pointerdown", activate, true);
    document.removeEventListener("focusin", activate, true);
  };
}
