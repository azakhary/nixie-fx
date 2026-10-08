import { Vector3 } from "three";
import type { Vec3 } from "../../engine/math";
import {
  sampleParticleScalarValue,
  type ParticleEmitterDefinition,
} from "../../engine/particles";
import { pruneThreeTrailPoints } from "./trailGeometry";

import type { ParticleSample, ThreeEmitterView } from "./rendererState";
export function updateThreeTrailHistory(
  view: ThreeEmitterView,
  emitter: ParticleEmitterDefinition,
  sample: ParticleSample,
  timeSeconds: number,
): void {
  if (!emitter.modules.trails) return;
  const settings = emitter.advanced.trails;
  if (sample.seed >= settings.ratio) return;
  const lifetimeSeconds = Math.max(
    0.001,
    sampleParticleScalarValue(
      settings.lifetime,
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  );
  const length = Math.max(
    0,
    sampleParticleScalarValue(
      settings.length,
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  );
  const width = Math.max(
    0.001,
    sampleParticleScalarValue(
      settings.width,
      sample.normalizedAge,
      sample.seed,
      sample.loopAge,
    ),
  );
  const key = `${sample.start.toFixed(6)}:${sample.seed.toFixed(6)}`;
  let history = view.trailHistories.get(key);
  if (!history) {
    history = { points: [], lastSeenFrame: timeSeconds };
    view.trailHistories.set(key, history);
  }
  const points = history.points;
  const last = points[points.length - 1];
  const dx = last ? sample.position[0] - last.position.x : 0;
  const dy = last ? sample.position[1] - last.position.y : 0;
  const dz = last ? sample.position[2] - last.position.z : 0;
  const append =
    !last || dx * dx + dy * dy + dz * dz >= settings.minVertexDistance ** 2;
  const pool = (view.trailPointPool ??= []);
  const point = append
    ? (pool.pop() ?? {
        dynamicParams: null,
        position: new Vector3(),
        timeSeconds: 0,
        lifetimeSeconds: 0,
        distanceFromHead: 0,
        color: [0, 0, 0] as Vec3,
        alpha: 0,
        width: 0,
        seed: 0,
        maxLength: undefined,
      })
    : last;
  if (view.trailResolution) {
    const dynamic = (point.dynamicParams ??= [0, 0, 0, 0]);
    for (let channel = 0; channel < 4; channel++) {
      dynamic[channel] = emitter.modules.customData
        ? sampleParticleScalarValue(
            emitter.advanced.customData.channels[channel]!,
            sample.normalizedAge,
            sample.seed,
            sample.loopAge,
          )
        : 0;
    }
    point.color[0] = sample.trailColor[0];
    point.color[1] = sample.trailColor[1];
    point.color[2] = sample.trailColor[2];
    point.alpha = sample.trailColor[3];
  } else {
    point.dynamicParams = null;
    point.color[0] = sample.color.r;
    point.color[1] = sample.color.g;
    point.color[2] = sample.color.b;
    point.alpha = sample.alpha;
  }
  point.position.set(
    sample.position[0],
    sample.position[1],
    sample.position[2],
  );
  point.timeSeconds = timeSeconds;
  point.lifetimeSeconds = lifetimeSeconds;
  point.width = width;
  point.maxLength = length > 0 ? length : undefined;
  point.seed = sample.seed;
  if (append) points.push(point);
  history.lastSeenFrame = timeSeconds;
  pruneThreeTrailPoints(
    points,
    length > 0 ? length : undefined,
    timeSeconds,
    pool,
  );
}

export function applyThreeLocalSpaceTrailShift(
  view: ThreeEmitterView,
  emitter: ParticleEmitterDefinition,
  emitterPosition: Vec3,
): void {
  const previous = view.trailEmitterPosition;
  if (
    emitter.modules.trails &&
    !emitter.advanced.trails.worldSpace &&
    view.trailHistories.size > 0
  ) {
    const dx = emitterPosition[0] - previous[0];
    const dy = emitterPosition[1] - previous[1];
    const dz = emitterPosition[2] - previous[2];
    if (dx !== 0 || dy !== 0 || dz !== 0) {
      for (const history of view.trailHistories.values()) {
        for (const point of history.points) {
          point.position.x += dx;
          point.position.y += dy;
          point.position.z += dz;
        }
      }
    }
  }
  previous[0] = emitterPosition[0];
  previous[1] = emitterPosition[1];
  previous[2] = emitterPosition[2];
}
