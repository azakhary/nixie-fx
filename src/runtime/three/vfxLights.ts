import { PointLight, Scene, Vector3, type Camera, type Light } from "three";
import type { VfxLightCandidate, VfxLightProducer } from "../lights/candidates";
import { VfxLightSelector } from "../lights/selection";
export type ThreeVfxLightBudget = 0 | 2 | 4;
const managers = new WeakMap<Scene, ThreeVfxLightManager>();
/** One manager per host scene, shared even by independent ThreeVfxRenderers. No owned frame loop. */
export class ThreeVfxLightManager {
  readonly stats = { candidates: 0, active: 0, budget: 0, sceneLights: 0 };
  private readonly producers = new Map<
    VfxLightProducer,
    { revision: number; ids: Set<string> }
  >();
  private readonly selector = new VfxLightSelector();
  private readonly pool: PointLight[] = [];
  private readonly cameraPosition = new Vector3();
  private budget: ThreeVfxLightBudget;
  private snapNext = false;
  /** Rebuild immediately after an explicit seek/restart, including while paused. */
  reset(): void {
    this.selector.clear();
    this.snapNext = true;
    this.apply();
  }
  constructor(
    private readonly scene: Scene,
    budget: ThreeVfxLightBudget = 2,
  ) {
    if (managers.has(scene))
      throw new Error("Use the existing VFX light manager for this scene.");
    managers.set(scene, this);
    this.budget = budget;
    this.setBudget(budget);
  }
  static forScene(
    scene: Scene,
    budget: ThreeVfxLightBudget = 2,
  ): ThreeVfxLightManager {
    return managers.get(scene) ?? new ThreeVfxLightManager(scene, budget);
  }
  add(producer: VfxLightProducer): () => void {
    if (!this.producers.has(producer))
      this.producers.set(producer, {
        revision: producer.lightRevision,
        ids: new Set(),
      });
    return () => this.remove(producer);
  }
  remove(producer: VfxLightProducer): void {
    const state = this.producers.get(producer);
    if (state) this.selector.remove(state.ids);
    this.producers.delete(producer);
    this.apply();
  }
  /** Host reserves game-light costs FIRST, then assigns this remaining VFX allowance. */
  setBudget(budget: ThreeVfxLightBudget): void {
    const nextBudget = budget === 4 ? 4 : budget === 2 ? 2 : 0;
    if (nextBudget !== this.budget) this.snapNext = true;
    this.budget = nextBudget;
    this.stats.budget = this.budget;
    this.selector.slots.length = Math.min(
      this.selector.slots.length,
      this.budget,
    );
    while (this.pool.length < this.budget) {
      const light = new PointLight(0xffffff, 0, 1, 2);
      light.name = "NixieFX pooled light";
      light.castShadow = false;
      this.pool.push(light);
    }
    // Stable attached pool size avoids shader recompilation as candidates change.
    for (let i = 0; i < this.pool.length; i++) {
      if (i < this.budget) this.scene.add(this.pool[i]!);
      else this.pool[i]!.removeFromParent();
    }
    this.apply();
  }
  update(dt: number, camera: Camera): void {
    const candidates: VfxLightCandidate[] = [];
    let discontinuity = this.snapNext;
    this.snapNext = false;
    const frozen = new Set<string>();
    for (const [producer, state] of this.producers) {
      const next = producer.getLightCandidates();
      const ids = new Set(next.map((c) => c.id));
      // Explicit hiding, removal and seek release immediately; particle deaths may fade in-place.
      if (producer.lightRevision !== state.revision || next.length === 0)
        this.selector.remove(state.ids);
      discontinuity ||= producer.lightRevision !== state.revision;
      state.revision = producer.lightRevision;
      state.ids = new Set([
        ...ids,
        ...this.selector.slots
          .map((s) => s.candidate.id)
          .filter((id) => state.ids.has(id)),
      ]);
      if (producer.lightsPaused) for (const id of ids) frozen.add(id);
      candidates.push(...next);
    }
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.selector.update(
      candidates,
      this.budget,
      discontinuity ? this.selector.fadeSeconds : dt,
      this.cameraPosition.toArray(),
      frozen,
    );
    this.stats.candidates = candidates.length;
    const owned = new Set(this.pool);
    this.stats.sceneLights = 0;
    this.scene.traverseVisible((object) => {
      if ((object as Light).isLight && !owned.has(object as PointLight))
        this.stats.sceneLights++;
    });
    this.apply();
  }
  private apply(): void {
    this.stats.active = this.selector.slots.length;
    this.pool.forEach((light, index) => {
      const slot = index < this.budget ? this.selector.slots[index] : undefined;
      light.intensity = slot ? slot.candidate.intensity * slot.gain : 0;
      if (!slot) return;
      light.position.fromArray(slot.candidate.position);
      light.color.setRGB(...slot.candidate.color);
      light.distance = slot.candidate.radius;
    });
  }
  dispose(): void {
    for (const light of this.pool) {
      light.removeFromParent();
      light.dispose();
    }
    this.pool.length = 0;
    this.producers.clear();
    this.selector.clear();
    this.stats.active = this.stats.candidates = 0;
    managers.delete(this.scene);
  }
}
