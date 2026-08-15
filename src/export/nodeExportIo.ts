import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExportIo, ExportIoDirent } from "./io";

/** node:fs-backed ExportIo used by the dev server middleware and tests. */
export const nodeExportIo: ExportIo = {
  exists: (path) => Promise.resolve(existsSync(path)),
  isFile: (path) =>
    Promise.resolve(existsSync(path) && statSync(path).isFile()),
  isDirectory: (path) =>
    Promise.resolve(existsSync(path) && statSync(path).isDirectory()),
  readDir: (path) =>
    Promise.resolve(
      readdirSync(path, { withFileTypes: true }).map<ExportIoDirent>(
        (entry) => ({
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
        }),
      ),
    ),
  readTextFile: (path) => Promise.resolve(readFileSync(path, "utf8")),
  writeTextFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return Promise.resolve();
  },
  copyFile: (source, target) => {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    return Promise.resolve();
  },
  fileSize: (path) => Promise.resolve(statSync(path).size),
  resetDir: (path) => {
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    return Promise.resolve();
  },
  homeDir: () => homedir(),
};
