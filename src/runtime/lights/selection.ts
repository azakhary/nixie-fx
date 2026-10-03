import type { Vec3 } from "../../engine/math";
import type { VfxLightCandidate } from "./candidates";

export interface VfxLightSlot {
  candidate: VfxLightCandidate;
  gain: number;
  retiring: boolean;
}
/** Backend-neutral selection. A replacement fades out before its slot can be reused. */
export class VfxLightSelector {
  readonly slots: VfxLightSlot[] = [];
  constructor(
    public fadeSeconds = 0.16,
    public hysteresis = 1.25,
  ) {}
  clear(): void {
    this.slots.length = 0;
  }
  remove(ids: ReadonlySet<string>): void {
    for (let i = this.slots.length - 1; i >= 0; i--) {
      if (ids.has(this.slots[i]!.candidate.id)) this.slots.splice(i, 1);
    }
  }
  update(
    candidates: readonly VfxLightCandidate[],
    budget: number,
    dt: number,
    camera: Vec3,
    frozen: ReadonlySet<string> = new Set(),
  ): readonly VfxLightSlot[] {
    const cap = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
    this.slots.length = Math.min(this.slots.length, cap);
    const current = new Set(
      this.slots.filter((s) => !s.retiring).map((s) => s.candidate.id),
    );
    const score = (c: VfxLightCandidate) => {
      const distance = Math.hypot(
        c.position[0] - camera[0],
        c.position[1] - camera[1],
        c.position[2] - camera[2],
      );
      return (
        ((c.intensity * c.radius * c.radius) /
          Math.max(1, distance * distance)) *
        (current.has(c.id) ? this.hysteresis : 1)
      );
    };
    const ordered = [...candidates]
      .filter(
        (c) =>
          c.radius > 0 &&
          c.intensity > 0 &&
          [c.radius, c.intensity, ...c.position, ...c.color].every(
            Number.isFinite,
          ),
      )
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const wanted = new Set(ordered.slice(0, cap).map((c) => c.id));
    const byId = new Map(ordered.map((c) => [c.id, c]));
    const step =
      Math.max(0, Number.isFinite(dt) ? dt : 0) /
      Math.max(0.001, this.fadeSeconds);
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const slot = this.slots[i]!;
      const next = byId.get(slot.candidate.id);
      if (next) slot.candidate = next;
      if (frozen.has(slot.candidate.id) && next) continue;
      slot.retiring = !wanted.has(slot.candidate.id);
      slot.gain = Math.max(
        0,
        Math.min(1, slot.gain + (slot.retiring ? -step : step)),
      );
      if (slot.retiring && slot.gain === 0) this.slots.splice(i, 1);
    }
    const occupied = new Set(this.slots.map((s) => s.candidate.id));
    for (const candidate of ordered) {
      if (this.slots.length >= cap) break;
      if (!wanted.has(candidate.id) || occupied.has(candidate.id)) continue;
      this.slots.push({ candidate, gain: Math.min(1, step), retiring: false });
      occupied.add(candidate.id);
    }
    return this.slots;
  }
}
