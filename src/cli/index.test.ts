import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultParticleEffect } from "../engine/particles";
import { runNixieFxCli } from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("nixie-fx CLI", () => {
  it("creates a normalized effect without rewriting the project file", async () => {
    const root = await createProject();
    const projectPath = join(root, "vfx-editor.prj");
    const projectBefore = await readFile(projectPath, "utf8");
    const output = captureOutput();

    const exitCode = await runNixieFxCli(
      [
        "effect",
        "create",
        "--project",
        root,
        "--name",
        "Fire Burst",
        "--profile",
        "three-world-3d",
      ],
      output.environment,
    );

    expect(exitCode).toBe(0);
    const effect = JSON.parse(
      await readFile(join(root, "effects/fire-burst.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(effect).toMatchObject({
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "fire-burst",
      name: "Fire Burst",
      targetProfile: "three-world-3d",
    });
    expect(Array.isArray(effect.emitters)).toBe(true);
    expect(await readFile(projectPath, "utf8")).toBe(projectBefore);
    expect(output.stderr).toEqual([]);
  });

  it("never overwrites an existing effect", async () => {
    const root = await createProject();
    const output = captureOutput();
    const args = [
      "effect",
      "create",
      "--project",
      root,
      "--name",
      "Fire Burst",
    ];

    expect(await runNixieFxCli(args, output.environment)).toBe(0);
    const effectPath = join(root, "effects/fire-burst.json");
    const first = await readFile(effectPath, "utf8");
    expect(await runNixieFxCli(args, output.environment)).toBe(1);
    expect(await readFile(effectPath, "utf8")).toBe(first);
    expect(last(output.stderr)).toContain("already exists");
  });

  it("creates a portable default with clean support on both backends", async () => {
    const root = await createProject();
    const output = captureOutput();

    expect(
      await runNixieFxCli(
        [
          "effect",
          "create",
          "--project",
          root,
          "--name",
          "Portable Spark",
          "--profile",
          "portable",
        ],
        output.environment,
      ),
    ).toBe(0);
    expect(await runNixieFxCli(["validate", root], output.environment)).toBe(0);
    expect(last(output.stdout)).toBe(
      "Validated 1 effect: 0 errors, 0 warnings.",
    );
    expect(await runNixieFxCli(["export", root], output.environment)).toBe(0);
    const manifest = JSON.parse(
      await readFile(join(root, "out/vfx/manifest.json"), "utf8"),
    ) as {
      effects?: Array<{
        support?: {
          portableSubset?: boolean;
          backends?: Record<string, { status?: string }>;
        };
      }>;
    };
    expect(manifest.effects?.[0]?.support).toMatchObject({
      portableSubset: true,
      backends: {
        pixi2d: { status: "supported" },
        three3d: { status: "supported" },
      },
    });
  });

  it("validates recognized authoring effects without writing output", async () => {
    const root = await createProject();
    await writeJson(
      join(root, "effects/valid.json"),
      createDefaultParticleEffect("valid", "Valid"),
    );
    await writeJson(join(root, "effects/not-an-effect.json"), {
      hello: "world",
    });
    const output = captureOutput();

    expect(await runNixieFxCli(["validate", root], output.environment)).toBe(0);
    expect(last(output.stdout)).toMatch(
      /^Validated 1 effect: 0 errors, \d+ warnings\.$/,
    );
    expect(output.stderr).toEqual([]);
  });

  it("returns failure and file-scoped diagnostics for invalid effects", async () => {
    const root = await createProject();
    await writeJson(join(root, "effects/broken.json"), {
      app: "vfx-editor",
      kind: "particle-effect",
      version: 1,
      id: "",
      name: "Broken",
      emitters: [],
    });
    const output = captureOutput();

    expect(await runNixieFxCli(["validate", root], output.environment)).toBe(1);
    expect(output.stderr.join("\n")).toContain("broken.json:id");
    expect(last(output.stderr)).toContain("1 error");
  });

  it("exports through the existing Node writer", async () => {
    const root = await createProject();
    await writeJson(
      join(root, "effects/fire.json"),
      createDefaultParticleEffect("fire", "Fire"),
    );
    const output = captureOutput();

    expect(await runNixieFxCli(["export", root], output.environment)).toBe(0);
    const manifest = JSON.parse(
      await readFile(join(root, "out/vfx/manifest.json"), "utf8"),
    ) as { kind?: string; effects?: unknown[] };
    expect(manifest.kind).toBe("vfx-manifest");
    expect(manifest.effects).toHaveLength(1);
    expect(last(output.stdout)).toBe("Exported 1 effect to out/vfx.");
  });

  it("rejects an escaping output path before export writes", async () => {
    const root = await createProject({ outputPath: "../outside" });
    const output = captureOutput();

    expect(await runNixieFxCli(["export", root], output.environment)).toBe(1);
    expect(last(output.stderr)).toContain("cannot contain . or .. segments");
  });

  it("validates the public starter project", async () => {
    const root = fileURLToPath(
      new URL("../../examples/starter-project", import.meta.url),
    );
    const output = captureOutput();

    expect(await runNixieFxCli(["validate", root], output.environment)).toBe(0);
    expect(last(output.stdout)).toBe(
      "Validated 1 effect: 0 errors, 0 warnings.",
    );
    expect(output.stderr).toEqual([]);
  });
});

async function createProject(
  settings: Record<string, unknown> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nixie-fx-cli-"));
  roots.push(root);
  await writeJson(join(root, "vfx-editor.prj"), {
    app: "vfx-editor",
    kind: "project",
    version: 1,
    id: "vfx-cli-test",
    name: "CLI Test",
    settings: {
      effectDataPath: "effects",
      outputPath: "out/vfx",
      assetRootPath: "assets",
      materialsFolder: "materials",
      allowExternalOutput: false,
      ...settings,
    },
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  });
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function last(values: readonly string[]): string | undefined {
  return values[values.length - 1];
}

function captureOutput(): {
  stdout: string[];
  stderr: string[];
  environment: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    environment: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}
