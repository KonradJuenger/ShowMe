import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FontUsage } from "../src/core/fonts";
import type { SystemFontFamily } from "../src/platform/api";
import {
  assetIdFromFilename,
  findManagedFile,
  importManagedFile,
  ensureLibraryIndex,
} from "./mediaLibrary";

const FONT_FOLDER = "fonts";
const MAX_FONT_BYTES = 32 * 1024 ** 2;
async function readFontBytes(file: string) {
  if ((await fs.stat(file)).size > MAX_FONT_BYTES)
    throw new Error("Font exceeds size limit");
  const bytes = await fs.readFile(file);
  if (bytes.length > MAX_FONT_BYTES) throw new Error("Font exceeds size limit");
  return bytes;
}

export interface ResolvedFontFace extends FontUsage {
  filePath: string;
}

export interface ManagedFontFace extends FontUsage {
  id: string;
  file: string;
  originalName: string;
}
export function managedFontFaceFromFilename(
  file: string,
): ManagedFontFace | null {
  if (!/\.(ttf|otf|woff2?)$/i.test(file)) return null;
  const id = assetIdFromFilename(file);
  if (!id) return null;
  const match = /^(.*)-(\d{3})(-italic)?$/.exec(
    file.slice(0, file.lastIndexOf("__")),
  );
  if (!match) return null;
  return {
    id,
    file,
    originalName: file,
    family: match[1],
    weight: Number(match[2]),
    italic: Boolean(match[3]),
  };
}

interface NativeFontFile {
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  filePath: string;
}

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 8_000_000) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(stderr.trim() || `${command} exited with code ${code}`),
        );
    });
  });
}

function normalizeFamily(value: string) {
  return value.trim().toLocaleLowerCase();
}

function inferWeight(value: string) {
  const text = value.toLocaleLowerCase().replace(/[_-]+/g, " ");
  if (/\b(thin|hairline)\b/.test(text)) return 100;
  if (/\b(extra light|extralight|ultra light|ultralight)\b/.test(text))
    return 200;
  if (/\b(light|semi light|semilight)\b/.test(text)) return 300;
  if (/\b(medium)\b/.test(text)) return 500;
  if (/\b(semi bold|semibold|demi bold|demibold)\b/.test(text)) return 600;
  if (/\b(extra bold|extrabold|ultra bold|ultrabold)\b/.test(text)) return 800;
  if (/\b(black|heavy)\b/.test(text)) return 900;
  if (/\b(bold)\b/.test(text)) return 700;
  return 400;
}

function inferItalic(value: string) {
  return /\b(italic|oblique)\b/i.test(value);
}

function stripTechnology(value: string) {
  return value.replace(/\s*\([^)]*(?:type|font)[^)]*\)\s*$/i, "").trim();
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

async function windowsFamilyNames() {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
$collection = [System.Drawing.Text.InstalledFontCollection]::new()
$names = @($collection.Families | ForEach-Object { $_.Name } | Sort-Object -Unique)
ConvertTo-Json -InputObject $names -Compress
`;
  const output = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
  return asArray(JSON.parse(output || "[]")).filter(
    (item): item is string => typeof item === "string",
  );
}

async function windowsFontFiles(): Promise<NativeFontFile[]> {
  const families = await windowsFamilyNames();
  const normalizedFamilies = families
    .map((family) => ({ family, key: normalizeFamily(family) }))
    .sort((a, b) => b.key.length - a.key.length);
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$roots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
)
$fontDirs = @(
  [Environment]::GetFolderPath('Fonts'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Fonts')
)
$result = @()
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  $props = (Get-ItemProperty -Path $root).PSObject.Properties | Where-Object {
    $_.MemberType -eq 'NoteProperty' -and $_.Name -notmatch '^PS'
  }
  foreach ($prop in $props) {
    $raw = [string]$prop.Value
    if ([string]::IsNullOrWhiteSpace($raw)) { continue }
    $candidate = $null
    if ([IO.Path]::IsPathRooted($raw) -and (Test-Path $raw)) {
      $candidate = (Resolve-Path $raw).Path
    } else {
      foreach ($dir in $fontDirs) {
        $joined = Join-Path $dir $raw
        if (Test-Path $joined) { $candidate = (Resolve-Path $joined).Path; break }
      }
    }
    if ($candidate) {
      $result += [PSCustomObject]@{ name = $prop.Name; path = $candidate }
    }
  }
}
ConvertTo-Json -InputObject $result -Compress
`;
  const output = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
  const parsed = asArray(JSON.parse(output || "[]"));
  const files: NativeFontFile[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.path !== "string")
      continue;
    const display = stripTechnology(record.name);
    const displayKey = normalizeFamily(display);
    const family = normalizedFamilies.find(
      (candidate) =>
        displayKey === candidate.key ||
        displayKey.startsWith(candidate.key + " "),
    )?.family;
    if (!family) continue;
    const suffix = display.slice(family.length).trim();
    files.push({
      family,
      style: suffix || "Regular",
      weight: inferWeight(suffix),
      italic: inferItalic(suffix),
      filePath: record.path,
    });
  }
  return files;
}

function collectMacTypefaceFiles(value: unknown): NativeFontFile[] {
  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  const items = asArray(root.SPFontsDataType);
  const result: NativeFontFile[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const filePath = typeof item.path === "string" ? item.path : "";
    const typefaces = asArray(item.typefaces);
    if (filePath && typefaces.length) {
      for (const rawFace of typefaces) {
        if (!rawFace || typeof rawFace !== "object") continue;
        const face = rawFace as Record<string, unknown>;
        const family =
          typeof face.family === "string"
            ? face.family
            : typeof item.family === "string"
              ? item.family
              : "";
        if (!family) continue;
        const style =
          typeof face.style === "string"
            ? face.style
            : typeof face._name === "string"
              ? face._name
              : "Regular";
        result.push({
          family,
          style,
          weight: inferWeight(style),
          italic: inferItalic(style),
          filePath,
        });
      }
      continue;
    }
    if (!filePath) continue;
    const name =
      typeof item.family === "string"
        ? item.family
        : typeof item._name === "string"
          ? path.basename(item._name, path.extname(item._name))
          : "";
    if (name)
      result.push({
        family: name,
        style: "Regular",
        weight: 400,
        italic: false,
        filePath,
      });
  }
  return result;
}

async function macFontFiles() {
  const output = await run("/usr/sbin/system_profiler", [
    "SPFontsDataType",
    "-json",
  ]);
  return collectMacTypefaceFiles(JSON.parse(output || "{}"));
}

async function linuxFontFiles() {
  const output = await run("fc-list", [
    "--format=%{family}\t%{style}\t%{file}\n",
  ]);
  const result: NativeFontFile[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [families = "", style = "Regular", filePath = ""] = line.split("\t");
    if (!filePath) continue;
    for (const family of families
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean))
      result.push({
        family,
        style,
        weight: inferWeight(style),
        italic: inferItalic(style),
        filePath,
      });
  }
  return result;
}

let nativeFilesPromise: Promise<NativeFontFile[]> | null = null;
function nativeFontFiles() {
  nativeFilesPromise ??= (
    process.platform === "win32"
      ? windowsFontFiles()
      : process.platform === "darwin"
        ? macFontFiles()
        : linuxFontFiles()
  ).catch((error) => {
    nativeFilesPromise = null;
    console.warn("Could not enumerate font files", error);
    return [];
  });
  return nativeFilesPromise;
}

function faceScore(face: NativeFontFile, usage: FontUsage) {
  if (normalizeFamily(face.family) !== normalizeFamily(usage.family))
    return Infinity;
  return (
    Math.abs(face.weight - usage.weight) +
    (face.italic === usage.italic ? 0 : 1000)
  );
}

export async function resolveSystemFontUsages(usages: FontUsage[]) {
  const files = await nativeFontFiles();
  const resolved: ResolvedFontFace[] = [];
  const missing: FontUsage[] = [];
  for (const usage of usages) {
    let best: NativeFontFile | undefined;
    let bestScore = Infinity;
    for (const candidate of files) {
      const score = faceScore(candidate, usage);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best || bestScore >= 1000) missing.push(usage);
    else resolved.push({ ...usage, filePath: best.filePath });
  }
  return { resolved, missing };
}

function fontRoot(assetRoot: string) {
  return path.join(assetRoot, FONT_FOLDER);
}

export async function readLibraryFontFaces(
  assetRoot: string,
): Promise<ManagedFontFace[]> {
  const faces: ManagedFontFace[] = [];
  const known = new Set<string>();
  const index = await ensureLibraryIndex(assetRoot);
  for (const entry of index.files.values()) {
    const face = managedFontFaceFromFilename(path.basename(entry.file));
    if (!face || known.has(face.id)) continue;
    faces.push(face);
    known.add(face.id);
  }
  return faces;
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeBase(value: string) {
  const forbidden = new Set('<>:"/\\|?*');
  const safe = Array.from(value.trim(), (character) =>
    forbidden.has(character) || character.charCodeAt(0) < 32 ? "_" : character,
  ).join("");
  return safe || "font";
}

export function managedFontPath(assetRoot: string, face: ManagedFontFace) {
  const byId = findManagedFile(assetRoot, face.id);
  if (byId) return byId;
  const root = path.resolve(fontRoot(assetRoot));
  const file = path.resolve(root, face.file);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const inside =
    process.platform === "win32"
      ? file.toLowerCase().startsWith(prefix.toLowerCase())
      : file.startsWith(prefix);
  if (!inside) throw new Error("Invalid managed font path");
  return file;
}

export async function saveFontBytesToLibrary(
  assetRoot: string,
  usage: FontUsage,
  originalName: string,
  bytes: Uint8Array,
): Promise<{ face: ManagedFontFace; created: boolean }> {
  if (bytes.byteLength > MAX_FONT_BYTES)
    throw new Error("Font exceeds size limit");
  const id = digest(bytes);
  const current = await readLibraryFontFaces(assetRoot);
  const ext = path.extname(originalName).toLocaleLowerCase() || ".font";
  const name = `${safeBase(usage.family)}-${usage.weight}${usage.italic ? "-italic" : ""}${ext}`;
  const imported = await importManagedFile(assetRoot, name, bytes);
  const file = path.basename(imported.file);
  const face: ManagedFontFace = {
    id,
    ...usage,
    file,
    originalName: path.basename(originalName),
  };
  const exact = current.find(
    (item) =>
      item.id === face.id &&
      normalizeFamily(item.family) === normalizeFamily(face.family) &&
      item.weight === face.weight &&
      item.italic === face.italic,
  );
  if (exact) return { face: exact, created: false };
  return { face, created: true };
}

export async function saveResolvedFontToLibrary(
  assetRoot: string,
  resolved: ResolvedFontFace,
) {
  const bytes = await readFontBytes(resolved.filePath);
  return saveFontBytesToLibrary(
    assetRoot,
    resolved,
    path.basename(resolved.filePath),
    bytes,
  );
}

function usageMatchesFace(usage: FontUsage, face: ManagedFontFace) {
  return (
    normalizeFamily(usage.family) === normalizeFamily(face.family) &&
    usage.weight === face.weight &&
    usage.italic === face.italic
  );
}

export async function resolveFontUsages(
  assetRoot: string,
  usages: FontUsage[],
) {
  const library = await readLibraryFontFaces(assetRoot);
  const resolved: ResolvedFontFace[] = [];
  const unresolved: FontUsage[] = [];
  for (const usage of usages) {
    const face = library.find((item) => usageMatchesFace(usage, item));
    if (!face) {
      unresolved.push(usage);
      continue;
    }
    const filePath = managedFontPath(assetRoot, face);
    try {
      const bytes = await readFontBytes(filePath);
      if (digest(bytes) !== face.id)
        throw new Error("Managed font hash mismatch");
      resolved.push({ ...usage, filePath });
    } catch {
      unresolved.push(usage);
    }
  }
  const native = unresolved.length ? await resolveSystemFontUsages(unresolved) : { resolved: [], missing: [] };
  return {
    resolved: [...resolved, ...native.resolved],
    missing: native.missing,
  };
}

export async function managedFontsFromLibrary(
  assetRoot: string,
): Promise<SystemFontFamily[]> {
  const library = await readLibraryFontFaces(assetRoot);
  const byFamily = new Map<string, SystemFontFamily>();
  for (const face of library) {
    let bytes: Uint8Array;
    try {
      const raw = await readFontBytes(managedFontPath(assetRoot, face));
      if (digest(raw) !== face.id) continue;
      bytes = new Uint8Array(raw);
    } catch {
      continue;
    }
    const key = normalizeFamily(face.family);
    const family = byFamily.get(key) ?? { family: face.family, weights: [] };
    family.weights = Array.from(new Set([...family.weights, face.weight])).sort(
      (a, b) => a - b,
    );
    family.sources = [
      ...(family.sources ?? []),
      {
        id: face.id,
        weight: face.weight,
        italic: face.italic,
        data: bytes,
      },
    ];
    byFamily.set(key, family);
  }
  return Array.from(byFamily.values()).sort((a, b) =>
    a.family.localeCompare(b.family, undefined, { sensitivity: "base" }),
  );
}
