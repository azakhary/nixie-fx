import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = resolve(ROOT, "src");

const ENTRY_BOUNDARIES = [
  {
    entry: "index.ts",
    forbidden: ["pixi.js", "three", "node:"],
  },
  {
    entry: "materials.ts",
    forbidden: ["pixi.js", "three", "node:"],
  },
  {
    entry: "project.ts",
    forbidden: ["pixi.js", "three", "node:"],
  },
  {
    entry: "export.ts",
    forbidden: ["pixi.js", "three", "node:"],
  },
  {
    entry: "pixi.ts",
    forbidden: ["three", "node:"],
  },
  {
    entry: "three.ts",
    forbidden: ["pixi.js", "node:"],
  },
  {
    entry: "export-node.ts",
    forbidden: ["pixi.js", "three"],
  },
] as const;

describe("public source boundaries", () => {
  for (const boundary of ENTRY_BOUNDARIES) {
    it(`${boundary.entry} does not reach forbidden dependencies`, async () => {
      const graph = await collectSourceGraph(resolve(SRC, boundary.entry));
      for (const forbidden of boundary.forbidden) {
        const hit = [...graph.external].find(
          (specifier) =>
            specifier === forbidden || specifier.startsWith(`${forbidden}/`),
        );
        expect(hit, `${boundary.entry} reaches ${hit}`).toBeUndefined();
      }
    });
  }

  it("production sources do not import private editor or product modules", async () => {
    const violations: string[] = [];
    for (const file of await listProductionSources(SRC)) {
      const source = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (
          specifier === "react" ||
          specifier === "react-dom" ||
          specifier === "vite" ||
          specifier.startsWith("@rockbite/") ||
          /(?:^|\/)editor(?:\/|$)/.test(specifier)
        ) {
          violations.push(`${relative(SRC, file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

async function collectSourceGraph(entry: string): Promise<{
  internal: Set<string>;
  external: Set<string>;
}> {
  const internal = new Set<string>();
  const external = new Set<string>();

  const visit = async (file: string): Promise<void> => {
    if (internal.has(file)) return;
    internal.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const dependency = await resolveSourceImport(file, specifier);
      if (dependency) await visit(dependency);
      else external.add(specifier);
    }
  };

  await visit(entry);
  return { internal, external };
}

async function resolveSourceImport(
  importer: string,
  specifier: string,
): Promise<string | null> {
  const unresolved = specifier.startsWith("@/")
    ? resolve(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(importer), specifier)
      : null;
  if (!unresolved) return null;

  for (const candidate of [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    resolve(unresolved, "index.ts"),
    resolve(unresolved, "index.tsx"),
  ]) {
    if (await isFile(candidate)) return candidate;
  }
  throw new Error(
    `${relative(ROOT, importer)} has unresolved source import ${specifier}.`,
  );
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?(["'])([^"']+)\1/g;
  for (const match of source.matchAll(staticPattern)) specifiers.push(match[2]);
  const dynamicPattern = /import\s*\(\s*(["'])([^"']+)\1\s*\)/g;
  for (const match of source.matchAll(dynamicPattern))
    specifiers.push(match[2]);
  return specifiers;
}

async function listProductionSources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listProductionSources(path)));
    if (
      entry.isFile() &&
      [".ts", ".tsx"].includes(extname(entry.name)) &&
      !/\.(?:test|spec)\.[^.]+$/.test(entry.name) &&
      !entry.name.includes("test-support")
    ) {
      files.push(path);
    }
  }
  return files;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
