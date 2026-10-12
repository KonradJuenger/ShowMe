export type LibraryLifecycleMode = "managed" | "keep-all" | "portable";
export const LIBRARY_RETENTION_MS = 10 * 24 * 60 * 60 * 1000;
export interface LibraryLifecycleInfo {
  mode: LibraryLifecycleMode | null;
  root: string;
  presentations: string;
  defaultPresentations: string;
}
export interface LibraryTrashItem {
  hash: string;
  trashedAt: string;
  originalRelativePath: string;
  bytes: number;
}
export interface LibraryScanResult {
  complete: boolean;
  errors: string[];
  presentations: number;
  referencedBytes: number;
  unusedBytes: number;
  trashBytes: number;
  otherBytes: number;
  trash: LibraryTrashItem[];
}
