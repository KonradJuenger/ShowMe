import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { create, type Font } from "fontkit";
import type { ResolvedFontFace } from "../fontLibrary";
import type { FontUsage } from "../../src/core/fonts";
import { resolveTextTypography } from "../../src/core/textTypography";
import type { TextElement } from "../../src/core/text";
import type {
  OutlineLayout,
  OutlineLayoutRequest,
} from "../../src/export/html/textOutlines";

export class ExportTextOutlines {
  private directory: string | undefined;
  private readonly fonts = new Map<
    string,
    Promise<{ font: Font; bytes: Buffer; id: string }>
  >();
  private readonly sent = new Set<string>();

  constructor(
    private readonly resolveFont: (
      usage: FontUsage,
    ) => Promise<ResolvedFontFace | null>,
    private readonly layout: (
      request: OutlineLayoutRequest,
    ) => Promise<OutlineLayout>,
  ) {}

  async prepare(element: TextElement) {
    const type = resolveTextTypography(undefined, element.content);
    if (/[\u0590-\u08ff\t]/u.test(element.content.text))
      throw Error(
        "Bidirectional text and tab stops are not supported by the SVG prototype",
      );
    const weight = type.bold ? Math.max(700, type.fontWeight) : type.fontWeight;
    const key = JSON.stringify([
      type.fontFamily.toLowerCase(),
      weight,
      type.italic,
    ]);
    let loaded = this.fonts.get(key);
    if (!loaded) {
      loaded = (async () => {
        const resolved = await this.resolveFont({
          family: type.fontFamily,
          weight,
          italic: type.italic,
        });
        if (!resolved) throw Error(`Font file unavailable: ${type.fontFamily}`);
        const file = resolved.filePath;
        if ((await fs.stat(file)).size > 32 * 1024 ** 2)
          throw Error("Font exceeds size limit");
        const bytes = await fs.readFile(file);
        let font = create(bytes);
        if (!("layout" in font))
          throw Error(
            "Font collections are not supported by the SVG prototype",
          );
        const actualWeight = (
          font as Font & { "OS/2"?: { usWeightClass: number } }
        )["OS/2"]?.usWeightClass;
        if (
          !font.variationAxes.wght &&
          actualWeight &&
          weight >= 600 !== actualWeight >= 600
        )
          throw Error("The requested font weight requires synthetic styling");
        if (type.italic !== (font.italicAngle !== 0))
          throw Error("The requested font style requires synthetic styling");
        if (font.variationAxes.wght) font = font.getVariation({ wght: weight });
        if (font.CPAL)
          throw Error("Colour fonts are not supported by the SVG prototype");
        return {
          font,
          bytes,
          id: createHash("sha256").update(bytes).update(key).digest("hex"),
        };
      })();
      this.fonts.set(key, loaded);
    }
    const { font, bytes, id } = await loaded;
    const layout = await this.layout({
      element,
      fontId: id,
      fontData: this.sent.has(id) ? "" : bytes.toString("base64"),
    });
    this.sent.add(id);
    const scale = type.fontSize / font.unitsPerEm;
    let minX = 0,
      minY = 0,
      maxX = element.frame.width,
      maxY = element.frame.height;
    const paths: string[] = [];
    for (const line of layout.lines) {
      const run = font.layout(
        line.text,
        type.letterSpacing === 0 ? undefined : { liga: false, clig: false },
      );
      if (run.glyphs.some((glyph) => glyph.id === 0))
        throw Error("The font does not contain all used glyphs");
      let x = line.x,
        y = line.baseline;
      for (let index = 0; index < run.glyphs.length; index++) {
        const glyph = run.glyphs[index],
          position = run.positions[index];
        const gx = x + position.xOffset * scale,
          gy = y - position.yOffset * scale;
        const outline = glyph.path.toSVG();
        if (outline) {
          const box = glyph.bbox;
          minX = Math.min(minX, gx + box.minX * scale);
          maxX = Math.max(maxX, gx + box.maxX * scale);
          minY = Math.min(minY, gy - box.maxY * scale);
          maxY = Math.max(maxY, gy - box.minY * scale);
          paths.push(
            `<path d="${outline}" transform="translate(${gx} ${gy}) scale(${scale} ${-scale})"/>`,
          );
        }
        x +=
          position.xAdvance * scale +
          type.letterSpacing * glyph.codePoints.length;
        y -= position.yAdvance * scale;
      }
      if (Math.abs(x - line.x - line.width) > Math.max(1, line.width * 0.002))
        throw Error("Font shaping differs from the browser layout");
    }
    // Include ink outside the text frame; canonical text content can overflow it.
    minX = Math.floor(minX - 1);
    minY = Math.floor(minY - 1);
    maxX = Math.ceil(maxX + 1);
    maxY = Math.ceil(maxY + 1);
    const width = maxX - minX,
      height = maxY - minY;
    if (
      ![minX, minY, width, height].every(Number.isFinite) ||
      width > 100000 ||
      height > 100000
    )
      throw Error("SVG text exceeds frame limits");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" fill="${type.color}">${paths.join("")}</svg>`;
    const assetId = createHash("sha256").update(svg).digest("hex");
    this.directory ??= await fs.mkdtemp(
      path.join(os.tmpdir(), "showme-html-text-"),
    );
    const file = path.join(this.directory, assetId + ".svg");
    await fs.writeFile(file, svg);
    return {
      file,
      mime: "image/svg+xml",
      id: assetId,
      local: {
        ...element.frame,
        x: minX,
        y: minY,
        width,
        height,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        flipX: false,
        flipY: false,
      },
    };
  }

  async dispose() {
    if (this.directory)
      await fs.rm(this.directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  }
}
