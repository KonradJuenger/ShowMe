import JSZip from "jszip";
import { powerPointCanvasSize } from "./presentationDimensions";
import {
  POWERPOINT_LIMITS,
  assertPowerPointArchiveBounds,
  assertPowerPointXmlBounds,
  readPowerPointEntry,
} from "./powerpointResources";
import type { Element as SceneElement } from "./element";
import { createBasicShape, createContainerElement } from "./elementFactory";
import { uid } from "./ids";
import { createTextElement, patchTextContent, type TextContent } from "./text";

// Import-only data. Documents and assets still use the current ShowMe model.
export interface ImportedPowerPointMedia {
  elementId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  crop: { left: number; top: number; right: number; bottom: number };
}

export interface ImportedPowerPointSlide {
  width: number;
  height: number;
  name: string;
  background: string;
  notes: string;
  elements: SceneElement[];
  media: ImportedPowerPointMedia[];
  warnings: string[];
}

const REL_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU_PER_POINT = 12700;
const descendants = (
  node: Document | Element | null | undefined,
  name: string,
): Element[] =>
  node ? Array.from(node.getElementsByTagNameNS("*", name)) : [];
const first = (node: Document | Element | null | undefined, name: string) =>
  descendants(node, name)[0] ?? null;
const child = (node: Element | null | undefined, name: string) =>
  Array.from(node?.children ?? []).find((item) => item.localName === name) ??
  null;
const attr = (node: Element | null | undefined, name: string) =>
  node?.getAttribute(name) ?? "";
const num = (node: Element | null | undefined, name: string, fallback = 0) => {
  const value = attr(node, name);
  return value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : fallback;
};
const bool = (value: string) => value === "1" || value === "true";
const pickAttr = (nodes: (Element | null)[], name: string, fallback: string) =>
  nodes.map((node) => attr(node, name)).find((value) => value !== "") ??
  fallback;
const pickChild = (nodes: (Element | null)[], name: string) =>
  nodes.map((node) => child(node, name)).find(Boolean) ?? null;

interface Relationship {
  target: string;
  type: string;
  external: boolean;
}
interface Part {
  doc: Document;
  rels: Map<string, Relationship>;
}
interface Theme {
  colors: Map<string, string>;
  mapping: Element | null;
  major: string;
  minor: string;
}
interface Context {
  part: Part;
  layout: Part | null;
  master: Part | null;
  theme: Theme;
  scale: number;
  shiftX: number;
  shiftY: number;
  defaults: Element | null;
  result: ImportedPowerPointSlide;
  zip: JSZip;
}

function parseXml(value: string) {
  assertPowerPointXmlBounds(value);
  const doc = new DOMParser().parseFromString(value, "application/xml");
  if (first(doc, "parsererror"))
    throw new Error("PowerPoint file contains invalid XML");
  return doc;
}

function resolveTarget(path: string, target: string) {
  const parts = (
    target.startsWith("/")
      ? target.slice(1)
      : `${path.slice(0, path.lastIndexOf("/"))}/${target}`
  ).split("/");
  const result: string[] = [];
  for (const part of parts) {
    if (part === "..") result.pop();
    else if (part && part !== ".") result.push(part);
  }
  return result.join("/");
}

function related(part: Part | null, type: string) {
  return Array.from(part?.rels.values() ?? []).find(
    (rel) => !rel.external && rel.type.endsWith(`/${type}`),
  )?.target;
}

function warning(context: Context, message: string) {
  if (!context.result.warnings.includes(message))
    context.result.warnings.push(message);
}

function color(
  node: Element | null,
  theme: Theme,
  fallback = "#111111",
): string {
  if (!node) return fallback;
  const rgb = first(node, "srgbClr");
  const sys = first(node, "sysClr");
  const scheme = first(node, "schemeClr");
  const key = attr(scheme, "val");
  const mapped =
    attr(theme.mapping, key) ||
    (
      { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2" } as Record<
        string,
        string
      >
    )[key] ||
    key;
  let value =
    attr(rgb, "val") ||
    attr(sys, "lastClr") ||
    theme.colors.get(mapped) ||
    fallback.slice(1);
  if (!/^[0-9a-f]{6}$/i.test(value)) return fallback;
  const source = rgb ?? sys ?? scheme;
  let channels = [0, 2, 4].map((index) =>
    parseInt(value.slice(index, index + 2), 16),
  );
  for (const transform of Array.from(source?.children ?? [])) {
    const fraction = num(transform, "val") / 100000;
    if (transform.localName === "tint")
      channels = channels.map((c) => c + (255 - c) * fraction);
    if (transform.localName === "shade" || transform.localName === "lumMod")
      channels = channels.map((c) => c * fraction);
    if (transform.localName === "lumOff")
      channels = channels.map((c) => c + 255 * fraction);
  }
  value = channels
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  return `#${value}`;
}

function placeholder(shape: Element) {
  return first(child(shape, "nvSpPr") ?? child(shape, "nvPicPr"), "ph");
}
function inheritedPlaceholder(shape: Element, part: Part | null) {
  const ph = placeholder(shape);
  if (!ph || !part) return null;
  const candidates = descendants(part.doc, "sp").filter((candidate) =>
    placeholder(candidate),
  );
  return (
    candidates.find(
      (candidate) => attr(placeholder(candidate), "idx") === attr(ph, "idx"),
    ) ??
    candidates.find(
      (candidate) =>
        (attr(placeholder(candidate), "type") || "obj") ===
        (attr(ph, "type") || "obj"),
    ) ??
    null
  );
}

function shapeChain(shape: Element, context: Context): Element[] {
  const layout = inheritedPlaceholder(shape, context.layout);
  const master = inheritedPlaceholder(layout ?? shape, context.master);
  return [shape, layout, master].filter((item): item is Element => !!item);
}

function frame(
  shape: Element,
  chain: Element[],
  context: Context,
): SceneElement["frame"] | null {
  const transforms =
    shape.localName === "grpSp"
      ? [child(child(shape, "grpSpPr"), "xfrm")]
      : chain.map((item) => child(child(item, "spPr"), "xfrm"));
  const off = pickChild(transforms, "off"),
    ext = pickChild(transforms, "ext");
  const width = num(ext, "cx") * context.scale,
    height = num(ext, "cy") * context.scale;
  if (!(width > 0 && height > 0)) {
    warning(context, "Objects without usable placement were skipped.");
    return null;
  }
  return {
    x: num(off, "x") * context.scale + context.shiftX,
    y: num(off, "y") * context.scale + context.shiftY,
    width,
    height,
    rotation: Number(pickAttr(transforms, "rot", "0")) / 60000,
    scaleX: 1,
    scaleY: 1,
    originX: 0.5,
    originY: 0.5,
    flipX: bool(pickAttr(transforms, "flipH", "0")),
    flipY: bool(pickAttr(transforms, "flipV", "0")),
  };
}

function appearance(
  shape: Element,
  chain: Element[],
  context: Context,
  element: SceneElement,
) {
  const props = chain.map((item) => child(item, "spPr"));
  const own = props[0];
  const fillOwner = props.find(
    (p) =>
      child(p, "solidFill") ||
      child(p, "noFill") ||
      child(p, "gradFill") ||
      child(p, "blipFill"),
  );
  const solid = child(fillOwner, "solidFill");
  const fillRef = first(child(shape, "style"), "fillRef");
  element.appearance.fill = solid
    ? color(solid, context.theme)
    : fillOwner
      ? null
      : fillRef && num(fillRef, "idx")
        ? color(fillRef, context.theme)
        : null;
  if (child(fillOwner, "gradFill") || child(fillOwner, "blipFill"))
    warning(context, "Gradient and picture shape fills are not supported.");
  const alpha = first(solid, "alpha");
  element.appearance.opacity = alpha
    ? Math.max(0, Math.min(1, num(alpha, "val") / 100000))
    : 1;
  const line = pickChild(props, "ln");
  if (line && !child(line, "noFill")) {
    element.appearance.strokeColor = color(
      child(line, "solidFill"),
      context.theme,
    );
    element.appearance.strokeWidth =
      num(line, "w", EMU_PER_POINT) * context.scale;
  }
  const geometry = child(own, "prstGeom") ?? pickChild(props, "prstGeom");
  const preset = attr(geometry, "prst");
  if (preset === "ellipse") element.geometry.type = "ellipse";
  else if (preset === "roundRect") {
    const adjustment = descendants(geometry, "gd").find(
      (gd) => attr(gd, "name") === "adj",
    );
    const fraction = adjustment
      ? Number(attr(adjustment, "fmla").replace(/^val\s+/, "")) / 100000
      : 0.16667;
    element.appearance.radius =
      Math.min(element.frame.width, element.frame.height) *
      Math.max(0, Math.min(0.5, fraction));
  } else if ((preset && preset !== "rect") || child(own, "custGeom")) {
    warning(context, "Some custom shapes were approximated as rectangles.");
  }
  if (first(own, "effectLst"))
    warning(context, "Shape effects are not supported.");
}

interface StyledRun {
  text: string;
  style: import("./textTypography").TextTypography & {
    autoSize: TextContent["autoSize"];
  };
}
interface Paragraph {
  runs: StyledRun[];
  align: import("./textTypography").TextTypography["align"];
  before: number;
  after: number;
  indent: number;
  lineHeight: number;
}

function textStyle(
  nodes: (Element | null)[],
  context: Context,
  fontRef: Element | null,
  fontScale: number,
): StyledRun["style"] {
  const themeFont = pickAttr(
    nodes.map((n) => child(n, "latin")),
    "typeface",
    attr(fontRef, "idx") === "major"
      ? context.theme.major
      : context.theme.minor,
  );
  const fontFamily = themeFont.startsWith("+mj")
    ? context.theme.major
    : themeFont.startsWith("+mn")
      ? context.theme.minor
      : themeFont;
  return {
    fontFamily: fontFamily || "Arial",
    fontWeight: bool(pickAttr(nodes, "b", "0")) ? 700 : 400,
    fontSize: Math.max(
      1,
      (Number(pickAttr(nodes, "sz", "2400")) / 100) *
        EMU_PER_POINT *
        context.scale *
        fontScale,
    ),
    bold: bool(pickAttr(nodes, "b", "0")),
    italic: bool(pickAttr(nodes, "i", "0")),
    color: color(pickChild(nodes, "solidFill") ?? fontRef, context.theme),
    align: "left",
    verticalAlign: "top",
    lineHeight: 1.15,
    letterSpacing:
      (Number(pickAttr(nodes, "spc", "0")) / 100) *
      EMU_PER_POINT *
      context.scale,
    autoSize: "none",
  };
}

function spacing(node: Element | null, fontSize: number, scale: number) {
  const points = child(node, "spcPts");
  return points
    ? (num(points, "val") / 100) * EMU_PER_POINT * scale
    : (num(child(node, "spcPct"), "val") / 100000) * fontSize;
}

function paragraphs(
  shape: Element,
  chain: Element[],
  context: Context,
): Paragraph[] {
  const body = child(shape, "txBody");
  const phType = attr(placeholder(shape), "type");
  const masterStyle = first(
    context.master?.doc,
    phType === "title" || phType === "ctrTitle"
      ? "titleStyle"
      : phType === "body" || phType === "subTitle" || placeholder(shape)
        ? "bodyStyle"
        : "otherStyle",
  );
  let number = 0;
  const fontRef = pickChild(
    chain.map((s) => child(s, "style")),
    "fontRef",
  );
  const bodyPrs = chain.map((s) => child(child(s, "txBody"), "bodyPr"));
  const autoFit = pickChild(bodyPrs, "normAutofit");
  const fontScale = num(autoFit, "fontScale", 100000) / 100000;
  return Array.from(body?.children ?? [])
    .filter((p) => p.localName === "p")
    .map((p) => {
      const own = child(p, "pPr"),
        level = num(own, "lvl");
      const levelName = `lvl${Math.min(8, level) + 1}pPr`;
      const inherited = chain.slice(1).map((s) => child(first(s, "p"), "pPr"));
      const props = [
        own,
        ...chain.map((s) =>
          child(child(child(s, "txBody"), "lstStyle"), levelName),
        ),
        ...inherited,
        child(masterStyle, levelName),
        child(context.defaults, levelName),
      ];
      const defaults = [
        child(own, "defRPr"),
        ...props.slice(1).map((pr) => child(pr, "defRPr")),
      ];
      const styleFor = (nodes: (Element | null)[]) =>
        textStyle(nodes, context, fontRef, fontScale);
      const base = styleFor([child(p, "endParaRPr"), ...defaults]);
      const runs: StyledRun[] = [];
      for (const node of Array.from(p.children)) {
        if (node.localName === "r" || node.localName === "fld")
          runs.push({
            text: child(node, "t")?.textContent ?? "",
            style: styleFor([child(node, "rPr"), ...defaults]),
          });
        if (node.localName === "br")
          runs.push({
            text: "\n",
            style: child(node, "rPr")
              ? styleFor([child(node, "rPr"), ...defaults])
              : (runs.at(-1)?.style ?? base),
          });
      }
      if (!runs.length) runs.push({ text: "", style: base });
      const bulletOwner = props.find(
        (pr) =>
          child(pr, "buNone") || child(pr, "buChar") || child(pr, "buAutoNum"),
      );
      let bullet = attr(child(bulletOwner, "buChar"), "char");
      const auto = child(bulletOwner, "buAutoNum");
      if (auto) {
        if (!number) number = num(auto, "startAt", 1);
        bullet = `${number++}.`;
      }
      if (bullet) runs.unshift({ text: `${bullet} `, style: runs[0].style });
      const alignValue = pickAttr(props, "algn", "l");
      if (alignValue === "just" || alignValue === "dist")
        warning(context, "Justified text was imported with left alignment.");
      const align =
        alignValue === "ctr" ? "center" : alignValue === "r" ? "right" : "left";
      const size = runs[0].style.fontSize;
      const lineSpace = pickChild(props, "lnSpc");
      const lineHeight = lineSpace
        ? Math.max(
            0.5,
            Math.min(5, spacing(lineSpace, size, context.scale) / size),
          )
        : 1.15;
      return {
        runs,
        align,
        before: spacing(pickChild(props, "spcBef"), size, context.scale),
        after: spacing(pickChild(props, "spcAft"), size, context.scale),
        indent: Number(pickAttr(props, "marL", "0")) * context.scale,
        lineHeight,
      };
    });
}

function addText(
  shape: Element,
  chain: Element[],
  context: Context,
  element: SceneElement,
) {
  const list = paragraphs(shape, chain, context);
  if (!list.some((p) => p.runs.some((run) => run.text))) return;
  const bodies = chain.map((s) => child(child(s, "txBody"), "bodyPr"));
  const inset = (name: string, fallback: number) =>
    Number(pickAttr(bodies, name, String(fallback))) * context.scale;
  const left = inset("lIns", 91440),
    right = inset("rIns", 91440);
  const top = inset("tIns", 45720),
    bottom = inset("bIns", 45720);
  const width = Math.max(1, element.frame.width - left - right),
    height = Math.max(1, element.frame.height - top - bottom);
  const anchor = pickAttr(bodies, "anchor", "t");
  const verticalAlign =
    anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top";
  if (pickAttr(bodies, "vert", "horz") !== "horz")
    warning(context, "Vertical text was imported horizontally.");
  const firstRun = list.flatMap((p) => p.runs).find((run) => run.text)!;
  const same = list.every(
    (p) =>
      p.align === list[0].align &&
      p.lineHeight === list[0].lineHeight &&
      !p.before &&
      !p.after &&
      !p.indent &&
      p.runs.every((run) =>
        run.text
          ? JSON.stringify(run.style) === JSON.stringify(firstRun.style)
          : run.style.fontSize === firstRun.style.fontSize,
      ),
  );
  element.container = true;
  // Text occupies an inset child so margins need no document model extension.
  if (same) {
    const text = createTextElement(uid(), { x: left, y: top });
    text.frame.width = width;
    text.frame.height = height;
    text.content = patchTextContent(text.content as TextContent, {
      ...firstRun.style,
      text: list.map((p) => p.runs.map((r) => r.text).join("")).join("\n"),
      align: list[0].align,
      lineHeight: list[0].lineHeight,
      verticalAlign,
    });
    element.children.push(text);
    return;
  }
  // The current model has one style per text element. Lay out styled runs as
  // ordinary editable text elements rather than adding a rich-text schema.
  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d");
  if (!measure) throw new Error("Could not measure imported PowerPoint text");
  const sizeOf = (text: string, style: StyledRun["style"]) => {
    measure.font = `${style.italic ? "italic " : ""}${style.bold ? "700" : "400"} ${style.fontSize}px ${JSON.stringify(style.fontFamily)}`;
    return (
      measure.measureText(text).width +
      Math.max(0, text.length - 1) * style.letterSpacing
    );
  };
  const fragments: {
    text: string;
    style: StyledRun["style"];
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];
  let y = 0;
  for (const paragraph of list) {
    y += paragraph.before;
    let line: { text: string; style: StyledRun["style"]; width: number }[] = [];
    let used = 0;
    const available = Math.max(1, width - paragraph.indent);
    const finish = () => {
      const lineHeight =
        Math.max(
          ...line.map((run) => run.style.fontSize),
          paragraph.runs[0].style.fontSize,
        ) * paragraph.lineHeight;
      let x =
        left +
        paragraph.indent +
        (paragraph.align === "center"
          ? (available - used) / 2
          : paragraph.align === "right"
            ? available - used
            : 0);
      for (const run of line) {
        const runHeight = run.style.fontSize * paragraph.lineHeight;
        fragments.push({
          ...run,
          x,
          y: top + y + lineHeight - runHeight,
          height: runHeight,
        });
        x += run.width;
      }
      y += lineHeight;
      line = [];
      used = 0;
    };
    const append = (text: string, style: StyledRun["style"]) => {
      const last = line.at(-1);
      if (last && JSON.stringify(last.style) === JSON.stringify(style)) {
        const previous = last.width;
        last.text += text;
        last.width = sizeOf(last.text, style);
        used += last.width - previous;
      } else {
        const width = sizeOf(text, style);
        line.push({ text, style, width });
        used += width;
      }
    };
    for (const run of paragraph.runs) {
      for (const token of run.text.match(/\n|[^\S\n]+|[^\s]+/g) ?? []) {
        if (token === "\n") {
          finish();
          continue;
        }
        const tokenWidth = sizeOf(token, run.style);
        if (used && used + tokenWidth > available && !/^\s+$/.test(token))
          finish();
        if (tokenWidth > available) {
          for (const letter of token) {
            if (used && used + sizeOf(letter, run.style) > available) finish();
            append(letter, run.style);
          }
        } else append(token, run.style);
      }
    }
    finish();
    y += paragraph.after;
  }
  const verticalOffset =
    verticalAlign === "middle"
      ? (height - y) / 2
      : verticalAlign === "bottom"
        ? height - y
        : 0;
  for (const fragment of fragments) {
    const text = createTextElement(uid(), {
      x: fragment.x,
      y: fragment.y + verticalOffset,
    });
    text.frame.width = Math.max(1, fragment.width + 1);
    text.frame.height = Math.max(1, fragment.height);
    text.content = patchTextContent(text.content as TextContent, {
      ...fragment.style,
      text: fragment.text,
      autoSize: "both",
      lineHeight: fragment.height / fragment.style.fontSize,
    });
    element.children.push(text);
  }
}

async function addImage(
  fill: Element,
  context: Context,
  element: SceneElement,
) {
  const blip = first(fill, "blip");
  const svg = first(fill, "svgBlip");
  const relationId = (svg ?? blip)?.getAttributeNS(REL_NS, "embed") ?? "";
  const rel = context.part.rels.get(relationId);
  const image = rel && !rel.external ? context.zip.file(rel.target) : null;
  if (!image) {
    warning(context, "Missing or linked images were skipped.");
    return false;
  }
  const extension = rel!.target.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
    } as Record<string, string>
  )[extension];
  if (!mime) {
    warning(context, "Unsupported image formats were skipped.");
    return false;
  }
  const rect = first(fill, "srcRect");
  const crop = {
    left: num(rect, "l") / 100000,
    top: num(rect, "t") / 100000,
    right: num(rect, "r") / 100000,
    bottom: num(rect, "b") / 100000,
  };
  if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) {
    warning(context, "Images with invalid crops were skipped.");
    return false;
  }
  context.result.media.push({
    elementId: element.id,
    name: rel!.target
      .split("/")
      .at(-1)!
      .replace(/^pptx[-_ ]/i, ""),
    mimeType: mime,
    bytes: await readPowerPointEntry(context.zip, image),
    crop,
  });
  element.clipChildren = true;
  return true;
}

async function addVideo(
  shape: Element,
  context: Context,
  element: SceneElement,
) {
  const video = first(shape, "videoFile");
  if (!video) return null;
  const embedded = first(shape, "media");
  const ids = [
    embedded?.getAttributeNS(REL_NS, "embed"),
    video.getAttributeNS(REL_NS, "link"),
  ];
  const relation = ids
    .map((id) => context.part.rels.get(id ?? ""))
    .find((rel) => rel && !rel.external && context.zip.file(rel.target));
  if (!relation) {
    warning(context, "Missing or linked videos were imported as cover images.");
    return false;
  }
  const extension = relation.target.split(".").at(-1)?.toLowerCase() ?? "";
  const mimeType = (
    { mp4: "video/mp4", webm: "video/webm" } as Record<string, string>
  )[extension];
  if (!mimeType) {
    warning(
      context,
      "Unsupported video formats were imported as cover images.",
    );
    return false;
  }
  context.result.media.push({
    elementId: element.id,
    name: relation.target
      .split("/")
      .at(-1)!
      .replace(/^pptx[-_ ]/i, ""),
    mimeType,
    bytes: await readPowerPointEntry(
      context.zip,
      context.zip.file(relation.target)!,
    ),
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  });
  element.clipChildren = true;
  return true;
}

async function importTree(
  tree: Element | null,
  context: Context,
  inherited = false,
): Promise<SceneElement[]> {
  const output: SceneElement[] = [];
  for (const shape of Array.from(tree?.children ?? [])) {
    if (["nvGrpSpPr", "grpSpPr", "extLst"].includes(shape.localName)) continue;
    if (inherited && placeholder(shape)) continue;
    if (!["sp", "pic", "grpSp"].includes(shape.localName)) {
      if (shape.localName === "AlternateContent") {
        const branch = child(shape, "Fallback") ?? child(shape, "Choice");
        output.push(...(await importTree(branch, context, inherited)));
      } else
        warning(
          context,
          "Tables, charts, and other unsupported objects were skipped.",
        );
      continue;
    }
    if (bool(attr(first(shape, "cNvPr"), "hidden"))) continue;
    const chain = shapeChain(shape, context);
    const placement = frame(shape, chain, context);
    if (!placement) continue;
    const element = createBasicShape(uid(), "rectangle");
    element.frame = placement;
    element.appearance.fill = null;
    element.name =
      attr(first(shape, "cNvPr"), "name").slice(0, 200) || undefined;
    if (shape.localName === "grpSp") {
      const transform = child(child(shape, "grpSpPr"), "xfrm");
      const childOff = child(transform, "chOff"),
        childExt = child(transform, "chExt");
      const childWidth = num(childExt, "cx") * context.scale,
        childHeight = num(childExt, "cy") * context.scale;
      if (!(childWidth > 0 && childHeight > 0)) {
        warning(context, "Groups without usable placement were skipped.");
        continue;
      }
      element.container = true;
      // Keep scaling inside the rotated outer group to preserve R*S exactly.
      const inner = createContainerElement(uid());
      inner.frame = {
        ...inner.frame,
        width: childWidth,
        height: childHeight,
        x: 0,
        y: 0,
        originX: 0,
        originY: 0,
        scaleX: placement.width / childWidth,
        scaleY: placement.height / childHeight,
      };
      inner.children = await importTree(
        shape,
        {
          ...context,
          shiftX: -num(childOff, "x") * context.scale,
          shiftY: -num(childOff, "y") * context.scale,
        },
        inherited,
      );
      element.children = [inner];
    } else if (shape.localName === "pic") {
      const video = await addVideo(shape, context, element);
      if (
        !video &&
        !(await addImage(child(shape, "blipFill") ?? shape, context, element))
      )
        continue;
      appearance(shape, chain, context, element);
    } else {
      appearance(shape, chain, context, element);
      addText(shape, chain, context, element);
      if (
        !element.content &&
        !element.children.length &&
        !element.appearance.fill &&
        !element.appearance.strokeWidth
      )
        continue;
    }
    output.push(element);
  }
  return output;
}

export async function parsePowerPoint(
  file: File,
): Promise<ImportedPowerPointSlide[]> {
  if (file.size > POWERPOINT_LIMITS.archiveBytes)
    throw new Error("PowerPoint archive exceeds size limit");
  const bytes = await file.arrayBuffer();
  assertPowerPointArchiveBounds(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const text = async (path: string) => {
    const entry = zip.file(path);
    return entry
      ? new TextDecoder().decode(
          await readPowerPointEntry(zip, entry, POWERPOINT_LIMITS.xmlBytes),
        )
      : undefined;
  };
  const cache = new Map<string, Promise<Part>>();
  const load = (path: string): Promise<Part> => {
    let pending = cache.get(path);
    if (!pending) {
      pending = (async () => {
        const value = await text(path);
        if (!value) throw new Error(`PowerPoint file is missing ${path}`);
        const relsPath = `${path.slice(0, path.lastIndexOf("/"))}/_rels/${path.split("/").at(-1)}.rels`;
        const relsValue = await text(relsPath);
        const rels = new Map<string, Relationship>();
        if (relsValue)
          for (const rel of descendants(parseXml(relsValue), "Relationship")) {
            rels.set(attr(rel, "Id"), {
              target: resolveTarget(path, attr(rel, "Target")),
              type: attr(rel, "Type"),
              external: attr(rel, "TargetMode") === "External",
            });
          }
        return { doc: parseXml(value), rels };
      })();
      cache.set(path, pending);
    }
    return pending;
  };
  const presentation = await load("ppt/presentation.xml");
  const size = first(presentation.doc, "sldSz");
  const cx = num(size, "cx"),
    cy = num(size, "cy");
  if (!(cx > 0 && cy > 0))
    throw new Error("PowerPoint file has invalid slide dimensions");
  const { width, height, scale } = powerPointCanvasSize(cx, cy);
  const slideIds = descendants(presentation.doc, "sldId");
  if (!slideIds.length)
    throw new Error("PowerPoint presentation has no slides");
  const output: ImportedPowerPointSlide[] = [];
  for (const slideId of slideIds) {
    const rel = presentation.rels.get(
      slideId.getAttributeNS(REL_NS, "id") ?? "",
    );
    if (!rel || rel.external)
      throw new Error("PowerPoint slide relationship is missing");
    const part = await load(rel.target);
    const layoutPath = related(part, "slideLayout");
    const layout = layoutPath ? await load(layoutPath) : null;
    const masterPath = related(layout, "slideMaster");
    const master = masterPath ? await load(masterPath) : null;
    const themePath =
      related(master, "theme") ?? related(presentation, "theme");
    const themeDoc = themePath ? (await load(themePath)).doc : null;
    const colors = new Map<string, string>([
      ["lt1", "ffffff"],
      ["dk1", "000000"],
      ["lt2", "eeeeee"],
      ["dk2", "111111"],
    ]);
    for (const entry of Array.from(
      first(themeDoc, "clrScheme")?.children ?? [],
    )) {
      colors.set(
        entry.localName,
        attr(first(entry, "srgbClr"), "val") ||
          attr(first(entry, "sysClr"), "lastClr"),
      );
    }
    const mapping =
      first(part.doc, "overrideClrMapping") ??
      first(layout?.doc, "overrideClrMapping") ??
      first(master?.doc, "clrMap");
    const theme: Theme = {
      colors,
      mapping,
      major:
        attr(first(first(themeDoc, "majorFont"), "latin"), "typeface") ||
        "Arial",
      minor:
        attr(first(first(themeDoc, "minorFont"), "latin"), "typeface") ||
        "Arial",
    };
    const result: ImportedPowerPointSlide = {
      width,
      height,
      name:
        attr(first(part.doc, "cSld"), "name") || `Slide ${output.length + 1}`,
      background: "#ffffff",
      notes: "",
      elements: [],
      media: [],
      warnings: [],
    };
    const context: Context = {
      part,
      layout,
      master,
      theme,
      scale,
      shiftX: 0,
      shiftY: 0,
      defaults: first(presentation.doc, "defaultTextStyle"),
      result,
      zip,
    };
    const backgroundPart = [part, layout, master].find((owner) =>
      first(owner?.doc, "bg"),
    );
    const bg = first(backgroundPart?.doc, "bg");
    const bgRef = child(bg, "bgRef");
    const fillList = first(themeDoc, "bgFillStyleLst");
    const bgStyle = bgRef
      ? (Array.from(fillList?.children ?? [])[num(bgRef, "idx") - 1001] ?? null)
      : null;
    result.background = color(
      first(bg, "solidFill") ?? bgStyle ?? bgRef,
      theme,
      "#ffffff",
    );
    if (first(bg, "gradFill"))
      warning(context, "Gradient backgrounds are not supported.");
    const backgroundImage = first(bg, "blipFill");
    if (backgroundImage && backgroundPart) {
      const image = createBasicShape(uid(), "rectangle", {
        x: context.shiftX,
        y: context.shiftY,
      });
      image.name = "PowerPoint background";
      image.appearance.fill = null;
      image.frame.width = cx * scale;
      image.frame.height = cy * scale;
      if (
        await addImage(
          backgroundImage,
          { ...context, part: backgroundPart },
          image,
        )
      )
        result.elements.push(image);
    }
    if (
      attr(part.doc.documentElement, "showMasterSp") !== "0" &&
      attr(part.doc.documentElement, "showMasterSp") !== "false"
    ) {
      if (
        master &&
        attr(layout?.doc.documentElement, "showMasterSp") !== "0" &&
        attr(layout?.doc.documentElement, "showMasterSp") !== "false"
      )
        result.elements.push(
          ...(await importTree(
            first(master.doc, "spTree"),
            { ...context, part: master, layout: null, master: null },
            true,
          )),
        );
      if (layout)
        result.elements.push(
          ...(await importTree(
            first(layout.doc, "spTree"),
            { ...context, part: layout, layout: null },
            true,
          )),
        );
    }
    result.elements.push(
      ...(await importTree(first(part.doc, "spTree"), context)),
    );
    const notesPath = related(part, "notesSlide");
    if (notesPath) {
      const notes = await load(notesPath);
      result.notes = descendants(notes.doc, "sp")
        .filter((s) => attr(placeholder(s), "type") === "body")
        .flatMap((s) =>
          descendants(child(s, "txBody"), "p").map((p) =>
            descendants(p, "t")
              .map((t) => t.textContent ?? "")
              .join(""),
          ),
        )
        .join("\n");
    }
    if (first(part.doc, "timing"))
      warning(context, "Animations are not imported.");
    output.push(result);
  }
  return output;
}
