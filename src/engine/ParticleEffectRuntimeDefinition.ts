import { prepareParticleCurve } from "./ParticleCurve";
import type { ParticleCurvePoint, ParticleEffectDefinition } from "./particles";

const sharedDefinitions = new WeakSet<ParticleEffectDefinition>();

/**
 * Marks a definition as shared: it is deeply frozen once, its curves are
 * prepared once, and every `ParticleEffectRunner` built from it afterwards
 * reuses it instead of deep-cloning per instance.
 *
 * Only pass catalog-owned definitions that nothing will edit again. An editor
 * that keeps mutating its definition must not share it; runners keep cloning
 * (and therefore isolating) any definition that is not shared.
 */
export function shareParticleEffectDefinition(
  definition: ParticleEffectDefinition,
): ParticleEffectDefinition {
  if (sharedDefinitions.has(definition)) return definition;
  freezeTree(definition, new WeakSet());
  freezeRuntimeCurves(definition);
  sharedDefinitions.add(definition);
  return definition;
}

/** The definition itself when it was shared, otherwise undefined. */
export function sharedParticleEffectDefinition(
  value: unknown,
): ParticleEffectDefinition | undefined {
  return isSharedParticleEffectDefinition(value) ? value : undefined;
}

export function isSharedParticleEffectDefinition(
  value: unknown,
): value is ParticleEffectDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    sharedDefinitions.has(value as ParticleEffectDefinition)
  );
}

/**
 * Owns the definition a runner simulates: a shared definition as-is, any other
 * one as a private clone. Editors keep handing in mutable definitions and get
 * the previous isolate-by-cloning behavior.
 */
export class ParticleEffectRuntimeDefinition {
  value: ParticleEffectDefinition;

  constructor(
    definition: ParticleEffectDefinition,
    private readonly clone: (
      definition: ParticleEffectDefinition,
    ) => ParticleEffectDefinition,
  ) {
    this.value = this.acquire(definition);
  }

  replace(definition: ParticleEffectDefinition): void {
    this.value = this.acquire(definition);
  }

  /**
   * Copy-on-write escape hatch: returns a privately owned, mutable definition,
   * replacing a shared one with a clone first. Nothing in the runtime mutates
   * the definition today (runtime parameter patches live on the runner, not on
   * the definition); this exists so that any future in-place patch cannot
   * write through to a shared, frozen definition.
   */
  mutable(): ParticleEffectDefinition {
    if (isSharedParticleEffectDefinition(this.value)) {
      this.value = this.clone(this.value);
    }
    return this.value;
  }

  private acquire(
    definition: ParticleEffectDefinition,
  ): ParticleEffectDefinition {
    if (isSharedParticleEffectDefinition(definition)) return definition;
    const owned = this.clone(definition);
    freezeRuntimeCurves(owned);
    return owned;
  }
}

/**
 * Freezes only the curve point arrays of a playback-owned definition, so the
 * prepared-curve cache may keep their derived control points. The definition
 * itself stays mutable for anything that still edits it.
 */
function freezeRuntimeCurves(value: object): void {
  for (const [key, child] of Object.entries(value)) {
    if (!child || typeof child !== "object") continue;
    if ((key === "curve" || key === "curveB") && Array.isArray(child)) {
      for (const point of child) Object.freeze(point);
      Object.freeze(child);
      prepareParticleCurve(child as readonly ParticleCurvePoint[]);
    } else {
      freezeRuntimeCurves(child as object);
    }
  }
}

function freezeTree(value: object, visited: WeakSet<object>): void {
  if (visited.has(value)) return;
  visited.add(value);
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) {
      freezeTree(child as object, visited);
    }
  }
  Object.freeze(value);
}
