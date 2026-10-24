import type { ExportDocument, ExportWarning } from "../shared";

export const HTML_EXPORT_FORMAT_VERSION = 1 as const;

export interface HtmlEmbeddedAsset {
  id: string;
  mime: string;
  data: string;
}

export interface HtmlEmbeddedFontSource {
  id: string;
  weight: number;
  italic: boolean;
  data: string;
}

export interface HtmlEmbeddedFontFamily {
  family: string;
  weights: number[];
  sources: HtmlEmbeddedFontSource[];
}

export interface HtmlExportPayload {
  kind: "showme-html-export";
  formatVersion: typeof HTML_EXPORT_FORMAT_VERSION;
  runtimeVersion: string;
  exportedAt: string;
  document: ExportDocument;
  assets: HtmlEmbeddedAsset[];
  fonts: HtmlEmbeddedFontFamily[];
  warnings: ExportWarning[];
}
