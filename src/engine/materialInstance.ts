import type { Vec4 } from "./math";
import { isRecord, safeString } from "./particleModuleSettingUtils";

/**
 * Engine-layer material *instance* data (techspec §3.1, §8).
 *
 * The emitter's `render.material` carries a `MaterialInstance` — a reference to
 * a `ShaderGraph` asset (`shaderId`) plus per-instance param overrides and a
 * MainTex ref. This is pure serializable data, so it lives in the engine layer
 * alongside `ParticleEmitterDefinition`; the richer authoring types
 * (`ShaderGraph`, `MaterialParam`, the node graph) and the graph compiler live
 * in `runtime/schema/materials.ts` (which re-exports these shapes). Keeping the
 * instance here avoids an `engine → runtime` import cycle (the engine is pure).
 */

export type MaterialParamValue = number | Vec4 | string | boolean;

/** The built-in fixed-function shader; the implicit material of a texture-only emitter. */
export const SPRITE_MASTER_SHADER_ID = "sprite-master";

/** Lightweight texture ref carried by an instance (mirrors VfxTextureAssetRef). */
export interface MaterialTextureRef {
  type: "texture";
  id: string;
  path: string;
}

export interface MaterialInstance {
  id: string;
  /** -> ShaderGraph.id */
  shaderId: string;
  paramOverrides: Record<string, MaterialParamValue>;
  /** Resolves the MainTex param (§8). `path` is project-relative. */
  mainTex?: MaterialTextureRef | null;
}

export function normalizeMaterialTextureRef(
  value: unknown,
): MaterialTextureRef | null {
  if (!isRecord(value)) return null;
  const path = safeString(value.path, "");
  if (!path) return null;
  return {
    type: "texture",
    id: safeString(value.id, path),
    path,
  };
}

export function normalizeMaterialInstance(value: unknown): MaterialInstance {
  const source = isRecord(value) ? value : {};
  const overridesSource = isRecord(source.paramOverrides)
    ? source.paramOverrides
    : {};
  const paramOverrides: Record<string, MaterialParamValue> = {};
  for (const [key, raw] of Object.entries(overridesSource)) {
    if (typeof raw === "number" || typeof raw === "boolean") {
      paramOverrides[key] = raw;
    } else if (typeof raw === "string") {
      paramOverrides[key] = raw;
    } else if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) {
      const v = raw as number[];
      paramOverrides[key] = [
        v[0] ?? 0,
        v[1] ?? 0,
        v[2] ?? 0,
        v[3] ?? 0,
      ] as Vec4;
    }
  }
  return {
    id: safeString(source.id, "material-instance"),
    shaderId: safeString(source.shaderId, SPRITE_MASTER_SHADER_ID),
    paramOverrides,
    mainTex: normalizeMaterialTextureRef(source.mainTex),
  };
}

/** A `render.material` value (`unknown`) normalized to an instance or `null`. */
export function normalizeOptionalMaterialInstance(
  value: unknown,
): MaterialInstance | null {
  if (!isRecord(value)) return null;
  return normalizeMaterialInstance(value);
}

export function createMaterialInstance(
  shaderId: string,
  id: string,
): MaterialInstance {
  return {
    id,
    shaderId,
    paramOverrides: {},
    mainTex: null,
  };
}

export function cloneMaterialInstance(
  instance: MaterialInstance,
): MaterialInstance {
  const paramOverrides: Record<string, MaterialParamValue> = {};
  for (const [key, value] of Object.entries(instance.paramOverrides)) {
    paramOverrides[key] = Array.isArray(value) ? ([...value] as Vec4) : value;
  }
  return {
    id: instance.id,
    shaderId: instance.shaderId,
    paramOverrides,
    mainTex: instance.mainTex ? { ...instance.mainTex } : null,
  };
}

/** Persist-when-non-default serialization with deterministic key order (§3.3, §12). */
export function serializeMaterialInstance(
  instance: MaterialInstance,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: instance.id,
    shaderId: instance.shaderId,
  };
  if (Object.keys(instance.paramOverrides).length > 0) {
    const sorted: Record<string, MaterialParamValue> = {};
    for (const key of Object.keys(instance.paramOverrides).sort()) {
      sorted[key] = instance.paramOverrides[key];
    }
    out.paramOverrides = sorted;
  }
  if (instance.mainTex) out.mainTex = instance.mainTex;
  return out;
}
