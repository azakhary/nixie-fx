/**
 * File-system access surface the export writer needs. Implemented by
 * `nodeExportIo` (dev server + tests, over node:fs) and by the web backend
 * (File System Access API over directory handles), so the same export pipeline
 * runs in both worlds. All paths are absolute strings using forward slashes.
 */
export interface ExportIoDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface ExportIo {
  exists(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  readDir(path: string): Promise<ExportIoDirent[]>;
  readTextFile(path: string): Promise<string>;
  /** Creates parent folders as needed. */
  writeTextFile(path: string, text: string): Promise<void>;
  /** Creates parent folders as needed. */
  copyFile(source: string, target: string): Promise<void>;
  fileSize(path: string): Promise<number>;
  /** Deletes the folder (if present) and recreates it empty. */
  resetDir(path: string): Promise<void>;
  /** Home folder for `~` expansion; null where the concept does not exist. */
  homeDir(): string | null;
}
