import type { SystemFontFamily } from "./api";

export interface LocalFontFace {
  family: string;
  style?: string;
  fullName?: string;
  postscriptName?: string;
}

const WEIGHT_NAMES: ReadonlyArray<readonly [string, number]> = [
  ["extra black", 900],
  ["ultra black", 900],
  ["black", 900],
  ["heavy", 900],
  ["extra bold", 800],
  ["ultra bold", 800],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["semi bold", 600],
  ["demi bold", 600],
  ["semibold", 600],
  ["demibold", 600],
  ["extra light", 200],
  ["ultra light", 200],
  ["extralight", 200],
  ["ultralight", 200],
  ["thin", 100],
  ["hairline", 100],
  ["light", 300],
  ["medium", 500],
  ["bold", 700],
  ["regular", 400],
  ["normal", 400],
  ["book", 400],
];

const FALLBACK_WEIGHTS = [400, 700];

export const fallbackSystemFonts: SystemFontFamily[] = [
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
].map((family) => ({ family, weights: [...FALLBACK_WEIGHTS] }));

function normalizeStyle(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function fontWeightFromFace(face: LocalFontFace): number {
  const descriptor = normalizeStyle(
    [face.style, face.fullName, face.postscriptName]
      .filter(Boolean)
      .join(" "),
  );
  for (const [name, weight] of WEIGHT_NAMES)
    if (descriptor.includes(name)) return weight;
  return 400;
}

export function collectSystemFontFamilies(
  faces: readonly LocalFontFace[],
): SystemFontFamily[] {
  const byFamily = new Map<string, Set<number>>();
  for (const face of faces) {
    const family = face.family.trim();
    if (!family) continue;
    const weights = byFamily.get(family) ?? new Set<number>();
    weights.add(fontWeightFromFace(face));
    byFamily.set(family, weights);
  }
  return Array.from(byFamily, ([family, weights]) => ({
    family,
    weights: Array.from(weights).sort((a, b) => a - b),
  })).sort((a, b) =>
    a.family.localeCompare(b.family, undefined, { sensitivity: "base" }),
  );
}

export function mergeSystemFontFamilies(
  ...catalogs: readonly SystemFontFamily[][]
): SystemFontFamily[] {
  const byFamily = new Map<string, SystemFontFamily>();
  for (const catalog of catalogs) {
    for (const item of catalog) {
      const family = item.family.trim();
      if (!family) continue;
      const key = family.toLocaleLowerCase();
      const current = byFamily.get(key);
      if (!current) {
        byFamily.set(key, {
          family,
          weights: Array.from(new Set(item.weights)).sort((a, b) => a - b),
          sources: item.sources ? [...item.sources] : undefined,
        });
        continue;
      }
      current.weights = Array.from(
        new Set([...current.weights, ...item.weights]),
      ).sort((a, b) => a - b);
      if (item.sources?.length) {
        const sourceKeys = new Set(
          (current.sources ?? []).map(
            (source) => `${source.id}:${source.weight}:${source.italic ? 1 : 0}`,
          ),
        );
        for (const source of item.sources) {
          const sourceKey = `${source.id}:${source.weight}:${source.italic ? 1 : 0}`;
          if (sourceKeys.has(sourceKey)) continue;
          current.sources = [...(current.sources ?? []), source];
          sourceKeys.add(sourceKey);
        }
      }
    }
  }
  return Array.from(byFamily.values()).sort((a, b) =>
    a.family.localeCompare(b.family, undefined, { sensitivity: "base" }),
  );
}
