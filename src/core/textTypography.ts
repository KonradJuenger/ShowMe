import { z } from "zod";
import { idSchema, uid } from "./ids";

export const textTypographySchema = z
  .object({
    fontFamily: z.string().trim().min(1).max(200),
    fontWeight: z.number().int().min(100).max(900),
    fontSize: z.number().finite().positive().max(100000),
    bold: z.boolean(),
    italic: z.boolean(),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    align: z.enum(["left", "center", "right"]),
    verticalAlign: z.enum(["top", "middle", "bottom"]),
    lineHeight: z.number().finite().min(0.5).max(5),
    letterSpacing: z.number().finite().min(-100).max(500),
  })
  .strict();
export type TextTypography = z.infer<typeof textTypographySchema>;
export const textFormatSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("local"), typography: textTypographySchema })
    .strict(),
  z
    .object({
      kind: z.literal("style"),
      styleId: idSchema,
      overrides: textTypographySchema.partial(),
    })
    .strict(),
]);
export type TextFormat = z.infer<typeof textFormatSchema>;
export const textStyleSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1).max(200),
    typography: textTypographySchema,
    defaultKind: z.enum(["heading", "text"]).optional(),
  })
  .strict();
export type TextStyle = z.infer<typeof textStyleSchema>;
export const textStyleNameKey = (name: string) => name.trim().toLowerCase();
export const DEFAULT_TEXT_TYPOGRAPHY: TextTypography = {
  fontFamily: "Arial",
  fontWeight: 400,
  fontSize: 64,
  bold: false,
  italic: false,
  color: "#111111",
  align: "left",
  verticalAlign: "top",
  lineHeight: 1.15,
  letterSpacing: 0,
};
export function defaultTextStyles(): TextStyle[] {
  return [
    {
      id: uid(),
      name: "Heading",
      defaultKind: "heading",
      typography: { ...DEFAULT_TEXT_TYPOGRAPHY, bold: true, fontWeight: 700 },
    },
    {
      id: uid(),
      name: "Text",
      defaultKind: "text",
      typography: { ...DEFAULT_TEXT_TYPOGRAPHY, fontSize: 32 },
    },
  ];
}
export type TextStyleSource = { textStyles: readonly TextStyle[] };
export function resolveTextTypography(
  source: TextStyleSource | undefined,
  content: { format: TextFormat },
): TextTypography {
  if (content.format.kind === "local") return content.format.typography;
  const format = content.format;
  const style = source?.textStyles.find((s) => s.id === format.styleId);
  if (!style) throw new Error("Unknown Text Style");
  return { ...style.typography, ...content.format.overrides };
}
export function normalizeTextOverrides(
  base: TextTypography,
  overrides: Partial<TextTypography>,
) {
  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([key, value]) => value !== base[key as keyof TextTypography],
    ),
  ) as Partial<TextTypography>;
}
export function patchTextFormat(
  source: TextStyleSource | undefined,
  format: TextFormat,
  patch: Partial<TextTypography>,
): TextFormat {
  if (format.kind === "local")
    return {
      kind: "local",
      typography: textTypographySchema.parse({
        ...format.typography,
        ...patch,
      }),
    };
  const style = source?.textStyles.find((s) => s.id === format.styleId);
  if (!style) throw new Error("Unknown Text Style");
  return {
    ...format,
    overrides: normalizeTextOverrides(
      style.typography,
      textTypographySchema.partial().parse({ ...format.overrides, ...patch }),
    ),
  };
}
