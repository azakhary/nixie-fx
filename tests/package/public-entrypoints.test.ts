import { describe, expect, it } from "vitest";
import * as core from "../../src/index";
import * as exportApi from "../../src/export";
import * as exportNode from "../../src/export-node";
import * as materials from "../../src/materials";
import * as pixi from "../../src/pixi";
import * as project from "../../src/project";
import * as three from "../../src/three";

describe("public entrypoints", () => {
  it("keeps renderer peers out of the root API", () => {
    expect(core.ParticleEffectRunner).toBeTypeOf("function");
    expect(core.createDefaultParticleEffect).toBeTypeOf("function");
    expect(core.validateVfxAuthoringEffect).toBeTypeOf("function");
    expect("PixiVfxRenderer" in core).toBe(false);
    expect("ThreeVfxRenderer" in core).toBe(false);
  });

  it("exposes the deliberate materials surface", () => {
    expect(materials.compileMaterial).toBeTypeOf("function");
    expect(materials.normalizeShaderGraph).toBeTypeOf("function");
    expect(materials.sampleGradient).toBeTypeOf("function");
  });

  it("exposes the canonical editor project format without I/O", () => {
    expect(project.EDITOR_PROJECT_FILE_NAME).toBe("vfx-editor.prj");
    expect(project.normalizeEditorProjectFile).toBeTypeOf("function");
    expect(project.normalizeProjectSettings).toBeTypeOf("function");
  });

  it("exposes Pixi renderer and material-preview APIs", () => {
    expect(pixi.PixiVfxRenderer).toBeTypeOf("function");
    expect(pixi.createMaterialPreviewFragment).toBeTypeOf("function");
  });

  it("exposes Three renderer and geometry repair APIs", () => {
    expect(three.ThreeVfxRenderer).toBeTypeOf("function");
    expect(three.repairMirroredGeometryWinding).toBeTypeOf("function");
  });

  it("keeps Node filesystem helpers out of the browser export API", () => {
    expect(exportApi.compileVfxExport).toBeTypeOf("function");
    expect(exportApi.loadVfxExportBundle).toBeTypeOf("function");
    expect(exportApi.writeVfxExportWithIo).toBeTypeOf("function");
    expect("nodeExportIo" in exportApi).toBe(false);
    expect("writeVfxExportFromProject" in exportApi).toBe(false);
    expect(exportNode.nodeExportIo).toBeTypeOf("object");
    expect(exportNode.writeVfxExportFromProject).toBeTypeOf("function");
  });
});
