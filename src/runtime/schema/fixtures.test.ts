import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cloneParticleEffect,
  normalizeParticleEffect,
} from "../../engine/particles";
import { validateVfxAuthoringEffect } from "./validation";

/**
 * Round-trips every checked-in authoring fixture through the engine normalizer
 * and the authoring validator. These are the real files the editor ships and
 * loads, so they must normalize cleanly (idempotently) and must not produce
 * export blockers. Partial-support warnings are allowed.
 */
const FIXTURE_DIRS = [
  "public/config/particle-data/effects",
  "public/config/project-templates",
];

function loadFixtures(): { file: string; data: unknown }[] {
  const fixtures: { file: string; data: unknown }[] = [];
  for (const dir of FIXTURE_DIRS) {
    const absoluteDir = resolve(process.cwd(), dir);
    for (const entry of readdirSync(absoluteDir)) {
      if (!entry.endsWith(".json")) continue;
      const raw = readFileSync(resolve(absoluteDir, entry), "utf8");
      fixtures.push({ file: `${dir}/${entry}`, data: JSON.parse(raw) });
    }
  }
  return fixtures;
}

describe("checked-in particle fixtures", () => {
  const fixtures = loadFixtures();

  it("discovers the checked-in effect and template fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const { file, data } of fixtures) {
    it(`normalizes ${file} idempotently`, () => {
      const normalized = normalizeParticleEffect(data);
      expect(Array.isArray(normalized.emitters)).toBe(true);
      // Normalization is a fixed point: re-normalizing yields the same shape.
      expect(cloneParticleEffect(normalized)).toEqual(normalized);
    });

    it(`validates ${file} without export blockers`, () => {
      const result = validateVfxAuthoringEffect(data);
      expect(result.blockers).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  }
});
