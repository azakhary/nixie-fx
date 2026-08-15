import { describe, expect, it } from "vitest";
import { normalizeEditorProjectFile, parseEditorProjectFile } from "./file";

const PROJECT = {
  app: "vfx-editor",
  kind: "project",
  version: 1,
  id: "vfx-example",
  name: "Example",
  settings: { effectDataPath: "effects" },
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

describe("editor project file", () => {
  it("normalizes optional settings without changing the project envelope", () => {
    expect(normalizeEditorProjectFile(PROJECT)).toEqual({
      ...PROJECT,
      settings: {
        effectDataPath: "effects",
        outputPath: "out/vfx",
        assetRootPath: ".",
        materialsFolder: "materials",
        allowExternalOutput: false,
      },
    });
  });

  it("rejects invalid JSON, foreign projects, and missing effect roots", () => {
    expect(() => parseEditorProjectFile("{")).toThrow(
      "Project file is not valid JSON",
    );
    expect(() =>
      normalizeEditorProjectFile({ ...PROJECT, app: "another-editor" }),
    ).toThrow("Project file is not a vfx-editor project");
    expect(() =>
      normalizeEditorProjectFile({ ...PROJECT, settings: {} }),
    ).toThrow("Project file is missing settings.effectDataPath");
  });
});
