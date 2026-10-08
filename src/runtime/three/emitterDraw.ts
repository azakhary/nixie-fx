import { ShaderMaterial } from "three";
import {
  resolveParticleDepthWrite,
  type ParticleEmitterDefinition,
  type ParticleEmitterRuntimeState,
} from "../../engine/particles";
import {
  materialBlendOverridesEmitter,
  resolveEffectiveParticleBlend,
} from "../schema/materials";
import { threeBlendingForEffectiveBlend } from "./materialAdapter";
import { clearThreeTrailView, drawThreeTrailView } from "./trailGeometry";

import { hideViewMeshes } from "./emitterView";
import { ThreeParticlePresentation } from "./particlePresentation";
import { ThreeParticleSampler } from "./particleSampler";
import {
  applyThreeLocalSpaceTrailShift,
  updateThreeTrailHistory,
} from "./particleTrailHistory";
import type {
  ThreeEmitterDrawResult,
  ThreeEmitterView,
  ThreeParticleFrameContext,
} from "./rendererState";
import {
  emptyEmitterDrawResult,
  renderOrderForParticleSortMode,
  updateInstancedParticleOrder,
} from "./rendererUtils";
export class ThreeEmitterDrawer {
  private readonly sampler: ThreeParticleSampler;
  private readonly presentation: ThreeParticlePresentation;
  constructor(private readonly context: ThreeParticleFrameContext) {
    this.sampler = new ThreeParticleSampler(context);
    this.presentation = new ThreeParticlePresentation(context);
  }
  drawEmitter(
    view: ThreeEmitterView,
    emitter: ParticleEmitterDefinition,
    state: ParticleEmitterRuntimeState,
    emitterIndex: number,
    timeSeconds: number,
  ): ThreeEmitterDrawResult {
    if (
      emitter.mode === "mesh" &&
      emitter.mesh.renderMode === "meshAsset" &&
      !this.context.renderGeometryOverrides.has(emitter.id) &&
      (!emitter.mesh.asset ||
        !this.context.options.meshProvider?.getMeshGeometry(emitter.mesh.asset))
    ) {
      hideViewMeshes(view, 0);
      view.instanced?.commit(0);
      clearThreeTrailView(view);
      view.trailMesh.removeFromParent();
      return emptyEmitterDrawResult();
    }
    const effectiveBlend = resolveEffectiveParticleBlend(
      emitter.render.blend,
      view.materialBlend,
    );
    const materialOwnsBlend = materialBlendOverridesEmitter(effectiveBlend);
    view.material.depthTest = emitter.render.depthTest;
    const depthWrite = materialOwnsBlend
      ? true
      : resolveParticleDepthWrite({
          ...emitter.render,
          blend:
            effectiveBlend === "additive"
              ? "additive"
              : effectiveBlend === "premultiplied"
                ? "premultiplied"
                : "alpha",
        });
    const blending = threeBlendingForEffectiveBlend(effectiveBlend);
    const premultiplied = effectiveBlend === "premultiplied";
    view.material.depthWrite = depthWrite;
    view.material.blending = blending;
    view.material.premultipliedAlpha = premultiplied;
    view.instanced?.setRenderState(emitter);
    if (!view.trailResolution) {
      view.trailMaterial.depthTest = emitter.render.depthTest;
      view.trailMaterial.depthWrite = depthWrite;
      view.trailMaterial.blending = blending;
      view.trailMaterial.premultipliedAlpha = premultiplied;
      if (materialOwnsBlend) view.trailMaterial.transparent = false;
    }
    if (materialOwnsBlend) view.material.transparent = false;
    applyThreeLocalSpaceTrailShift(view, emitter, this.context.position);

    let visibleCount = 0;
    let bloomSourceCount = 0;
    let instancedDistanceSquaredSum = 0;
    let instancedStartSum = 0;
    if (view.instanced) {
      updateInstancedParticleOrder(
        state,
        emitter.render.sortMode,
        view.particleOrder,
      );
    }
    for (let drawIndex = 0; drawIndex < state.activeCount; drawIndex++) {
      const particleIndex = view.instanced
        ? (view.particleOrder[drawIndex] ?? drawIndex)
        : drawIndex;
      const sample = this.sampler.sampleParticle(
        emitter,
        state,
        particleIndex,
        timeSeconds,
        view.materialFixed,
        view.materialParticleColorUsage,
      );
      if (sample)
        this.context.lightCandidates.addParticle(
          emitter,
          state,
          particleIndex,
          sample,
          this.context.position,
        );
      if (!sample?.visible) continue;
      // A carrier can be invisible while feeding an independently shaded trail.
      // Record history before culling its surface, not before simulation.
      updateThreeTrailHistory(view, emitter, sample, timeSeconds);
      // Custom shader outputs may ignore or invert particle alpha. Only cull
      // provably transparent fixed-function surfaces; opaque materials own alpha.
      const surfaceVisible =
        sample.alpha > 0 ||
        view.material instanceof ShaderMaterial ||
        materialOwnsBlend;
      if (!surfaceVisible) continue;
      if (view.instanced) {
        const distanceSquared = this.presentation.applySampleToInstanced(
          view.instanced,
          sample,
          view,
          emitter,
          emitterIndex,
          particleIndex,
          visibleCount,
        );
        instancedDistanceSquaredSum += distanceSquared;
        instancedStartSum += sample.start;
      } else {
        const mesh = this.presentation.acquireMesh(view, visibleCount);
        this.presentation.applySampleToMesh(
          mesh,
          sample,
          view,
          emitter,
          emitterIndex,
          particleIndex,
          timeSeconds,
        );
      }
      visibleCount++;
      if (sample.emissiveStrength > this.context.previewBloomThreshold) {
        bloomSourceCount++;
      }
    }
    hideViewMeshes(view, visibleCount);
    if (view.instanced && visibleCount > 1) {
      // Distance sort modes re-order the written instances against the camera
      // so blending inside the single instanced draw resolves correctly (F13).
      if (emitter.render.sortMode === "distanceFarFirst") {
        view.instanced.sortByCameraDistance(visibleCount, true);
      } else if (emitter.render.sortMode === "distanceNearFirst") {
        view.instanced.sortByCameraDistance(visibleCount, false);
      }
    }
    view.instanced?.commit(visibleCount);
    // The instanced mesh is one object, so the legacy per-mesh render-order
    // banding applies at emitter granularity via representative (mean)
    // distance/age. Intra-emitter ordering is the instance write order above.
    view.instanced?.setRenderOrder(
      renderOrderForParticleSortMode(
        this.context.renderOrder +
          (this.context.emitterLayerRanks[emitterIndex] ?? emitterIndex),
        emitter.render.sortMode,
        visibleCount > 0 ? instancedDistanceSquaredSum / visibleCount : 0,
        visibleCount > 0 ? instancedStartSum / visibleCount : 0,
      ),
    );
    let trailDrawCalls = 0;
    if (emitter.modules.trails) {
      if (!view.trailMesh.parent) this.context.root.add(view.trailMesh);
      view.trailMesh.renderOrder =
        this.context.renderOrder +
        (this.context.emitterLayerRanks[emitterIndex] ?? emitterIndex);
      drawThreeTrailView(
        view,
        emitter,
        this.context.camera,
        timeSeconds,
        this.context.position,
      );
      trailDrawCalls = view.trailMesh.visible ? 1 : 0;
    } else {
      clearThreeTrailView(view);
      view.trailMesh.removeFromParent();
    }
    return {
      visibleParticles: visibleCount,
      bloomSourceParticles: bloomSourceCount,
      drawCalls:
        (visibleCount > 0 ? (view.instanced ? 1 : visibleCount) : 0) +
        trailDrawCalls,
      instancedDrawCalls: visibleCount > 0 && view.instanced ? 1 : 0,
      legacyParticleDrawCalls: view.instanced ? 0 : visibleCount,
    };
  }
}
