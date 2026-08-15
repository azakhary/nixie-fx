import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PIXI_RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(PIXI_RUNTIME_ROOT, "../..");

describe("Pixi runtime import boundary", () => {
  it("does not import editor modules", async () => {
    const files = await listSourceFiles(PIXI_RUNTIME_ROOT);
    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (hasEditorImport(source)) {
        violations.push(path.relative(SOURCE_ROOT, file));
      }
    }

    expect(violations).toEqual([]);
  });
});

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(fullPath)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function hasEditorImport(source: string): boolean {
  return /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["'](?:@\/editor|(?:\.\.\/)+editor)\//m.test(
    source,
  );
}
