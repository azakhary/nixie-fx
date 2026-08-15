import { describe, expect, it } from "vitest";
import {
  normalizeProjectSettings,
  normalizeProjectSettingsPath,
  validateProjectSettingsPath,
  validateProjectSettingsPaths,
} from "./settings";

describe("project settings", () => {
  it("preserves the editor defaults and optional last effect", () => {
    expect(normalizeProjectSettings(undefined)).toEqual({
      effectDataPath: ".",
      outputPath: "out/vfx",
      assetRootPath: ".",
      materialsFolder: "materials",
      allowExternalOutput: false,
    });
    expect(
      normalizeProjectSettings({
        effectDataPath: " effects ",
        lastEffectFile: " fire.json ",
      }),
    ).toMatchObject({
      effectDataPath: "effects",
      lastEffectFile: "fire.json",
    });
  });

  it("normalizes duplicate and trailing forward slashes", () => {
    expect(normalizeProjectSettingsPath(" effects//boss/ ")).toBe(
      "effects/boss",
    );
    expect(normalizeProjectSettingsPath("  ")).toBe(".");
  });

  it("allows external source roots but gates external output", () => {
    expect(
      validateProjectSettingsPath("../shared/effects", "Effect Data", {
        allowExternal: true,
      }),
    ).toBeNull();
    expect(validateProjectSettingsPath("../out", "Export Output")).toContain(
      ". or ..",
    );
    expect(
      validateProjectSettingsPath("../out", "Export Output", {
        allowExternal: true,
      }),
    ).toBeNull();
    expect(
      validateProjectSettingsPath(
        "https://example.test/effects",
        "Effect Data",
        { allowExternal: true },
      ),
    ).toContain("URL");
  });

  it("requires a real materials subfolder", () => {
    expect(
      validateProjectSettingsPaths({
        effectDataPath: ".",
        outputPath: "out/vfx",
        assetRootPath: ".",
        materialsFolder: ".",
        allowExternalOutput: false,
      }),
    ).toEqual([
      {
        key: "materialsFolder",
        label: "Materials Folder",
        message: "Materials Folder must be a folder under the asset root.",
      },
    ]);
  });
});
