export const COLLABORATOR_COLORS = [
  "#2563eb", "#b42318", "#047857", "#7c3aed", "#a63c00", "#0e7490",
] as const;

export function collaboratorColor(displayName: string): string {
  const normalized = displayName.trim().normalize("NFKC").toLocaleLowerCase("en-US");
  let hash = 2166136261;
  for (const character of normalized) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return COLLABORATOR_COLORS[(hash >>> 0) % COLLABORATOR_COLORS.length];
}
