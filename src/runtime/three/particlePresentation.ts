import {
  Euler,
  Matrix4,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from "three";
import type { Vec3 } from "../../engine/math";
import {
  resolveParticleDepthWrite,
  type ParticleEmitterDefinition,
} from "../../engine/particles";
import {
  materialBlendOverridesEmitter,
  resolveEffectiveParticleBlend,
} from "../schema/materials";
import type { ThreeVfxInstancedView } from "./renderAdapter";
import {
  isThreeParticleMaterial,
  threeBlendingForEffectiveBlend,
} from "./materialAdapter";
import { applyThreeTextureFrame } from "./textureFrames";
import { cloneShaderMaterialSharingTextures } from "./textureViews";

import {
  applyThreeShaderSample,
  materialSamplesTextureAlpha,
} from "./particleMaterialSample";
import type {
  ParticleSample,
  ThreeEmitterView,
  ThreeParticleFrameContext,
} from "./rendererState";
import {
  DEFAULT_NORMAL,
  DEFAULT_UP,
  normalizeOr,
  perpendicularUnitVector,
  renderOrderForParticleSortMode,
} from "./rendererUtils";
export class ThreeParticlePresentation {
  private readonly scratchWorld = new Vector3();
  private readonly scratchAlignmentAxis = new Vector3();
  private readonly scratchRight = new Vector3();
  private readonly scratchForward = new Vector3();
  private readonly scratchQuaternion = new Quaternion();
  private readonly scratchRollQuaternion = new Quaternion();
  private readonly scratchEuler = new Euler();
  private readonly scratchMatrix = new Matrix4();
  private readonly scratchBasisMatrix = new Matrix4();
  private readonly scratchPivotMatrix = new Matrix4();
  private readonly scratchScale = new Vector3();
  constructor(private readonly context: ThreeParticleFrameContext) {}
  private applySampleOrientation(
    sample: ParticleSample,
    emitter: ParticleEmitterDefinition,
  ): void {
    if (
      emitter.render.alignAxis === "screen" &&
      emitter.render.facing === "cameraPlane"
    ) {
      this.scratchQuaternion.copy(this.context.camera.quaternion);
      this.context.camera.getWorldDirection(this.scratchForward);
      this.scratchForward.multiplyScalar(-1);
      sample.normal.copy(normalizeOr(this.scratchForward, DEFAULT_NORMAL));
      return;
    }

    const up = normalizeOr(
      this.scratchAlignmentAxis.copy(sample.alignmentAxis),
      DEFAULT_UP,
    );
    if (emitter.render.facing === "off") {
      this.scratchQuaternion.setFromUnitVectors(DEFAULT_NORMAL, up);
      sample.normal.copy(up);
      return;
    }

    if (emitter.render.facing === "cameraPosition") {
      this.scratchForward.set(
        this.context.camera.position.x - sample.position[0],
        this.context.camera.position.y - sample.position[1],
        this.context.camera.position.z - sample.position[2],
      );
    } else {
      this.context.camera.getWorldDirection(this.scratchForward);
      this.scratchForward.multiplyScalar(-1);
    }
    const forward = normalizeOr(this.scratchForward, DEFAULT_NORMAL);
    const right = this.scratchRight.crossVectors(up, forward);
    if (right.lengthSq() <= 0.000001) {
      perpendicularUnitVector(up, right);
      forward.crossVectors(right, up);
    } else {
      right.normalize();
      forward.crossVectors(right, up);
    }
    normalizeOr(forward, DEFAULT_NORMAL);
    this.scratchBasisMatrix.makeBasis(right, up, forward);
    this.scratchQuaternion.setFromRotationMatrix(this.scratchBasisMatrix);
    sample.normal.copy(forward);
  }

  applySampleToMesh(
    mesh: Mesh,
    sample: ParticleSample,
    view: ThreeEmitterView,
    emitter: ParticleEmitterDefinition,
    emitterIndex: number,
    particleIndex: number,
    timeSeconds: number,
  ): void {
    const material = Array.isArray(mesh.material)
      ? mesh.material[0]
      : mesh.material;
    if (!material) return;
    if (!isThreeParticleMaterial(material)) return;
    if (material instanceof ShaderMaterial) {
      applyThreeShaderSample(
        material,
        emitter,
        view.textureFrames,
        sample,
        sample.textureFrameIndex,
        view.materialFixed,
        view.materialBlend,
        view.materialOpacityIsConstantOne,
        timeSeconds,
      );
    } else {
      applyThreeTextureFrame(
        material,
        view.textureFrames,
        sample.textureFrameIndex,
        view.materialFixed,
        timeSeconds,
      );
      const effectiveBlend = resolveEffectiveParticleBlend(
        emitter.render.blend,
        view.materialBlend,
      );
      material.depthTest = emitter.render.depthTest;
      material.color.copy(sample.color);
      if (materialBlendOverridesEmitter(effectiveBlend)) {
        // Material-authoritative opaque/cutout pass: depth-written and never
        // routed to the transparent pass, regardless of sample.alpha (I12-G).
        material.depthWrite = true;
        material.blending = threeBlendingForEffectiveBlend(effectiveBlend);
        material.opacity = effectiveBlend === "opaque" ? 1 : sample.alpha;
        material.transparent = false;
      } else {
        material.depthWrite = resolveParticleDepthWrite(
          {
            ...emitter.render,
            blend:
              effectiveBlend === "additive"
                ? "additive"
                : effectiveBlend === "premultiplied"
                  ? "premultiplied"
                  : "alpha",
          },
          sample.alpha,
        );
        material.blending = threeBlendingForEffectiveBlend(effectiveBlend);
        material.premultipliedAlpha = effectiveBlend === "premultiplied";
        material.opacity = sample.alpha;
        // A sampled texture alpha is live per-pixel opacity: flipping to the
        // opaque pass at sample.alpha 1 would disable blending and draw the
        // sprite's full quad. Untextured (or constant-opacity) particles keep
        // the sample.alpha gate, so opaque mesh assets stay opaque (I12-A).
        material.transparent =
          sample.alpha < 1 ||
          effectiveBlend === "additive" ||
          effectiveBlend === "premultiplied" ||
          materialSamplesTextureAlpha(material, emitter);
      }
      if ("emissive" in material) {
        // Only lit (MeshStandard) materials carry emissive: the HDR part of
        // the particle color glows on top of the scene lighting.
        material.emissive.copy(sample.color);
        material.emissiveIntensity = Math.max(0, sample.emissiveStrength - 1);
      }
      material.needsUpdate = true;
    }

    this.scratchWorld.set(
      sample.position[0],
      sample.position[1],
      sample.position[2],
    );
    mesh.renderOrder = renderOrderForParticleSortMode(
      this.context.renderOrder +
        (this.context.emitterLayerRanks[emitterIndex] ?? emitterIndex),
      emitter.render.sortMode,
      this.scratchWorld.distanceToSquared(this.context.camera.position),
      sample.start,
    );
    const matrix = this.writeSampleMatrix(
      sample,
      view,
      emitter,
      emitterIndex,
      particleIndex,
    );

    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.visible = true;
  }

  /** Returns the particle's squared world distance to the camera. */
  applySampleToInstanced(
    instanced: ThreeVfxInstancedView,
    sample: ParticleSample,
    view: ThreeEmitterView,
    emitter: ParticleEmitterDefinition,
    emitterIndex: number,
    particleIndex: number,
    visibleIndex: number,
  ): number {
    const matrix = this.writeSampleMatrix(
      sample,
      view,
      emitter,
      emitterIndex,
      particleIndex,
    );
    const dx = sample.position[0] - this.context.camera.position.x;
    const dy = sample.position[1] - this.context.camera.position.y;
    const dz = sample.position[2] - this.context.camera.position.z;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    instanced.write(
      visibleIndex,
      matrix,
      sample.color,
      sample.alpha,
      distanceSquared,
      sample,
      emitter,
    );
    return distanceSquared;
  }

  private writeSampleMatrix(
    sample: ParticleSample,
    view: ThreeEmitterView,
    emitter: ParticleEmitterDefinition,
    emitterIndex: number,
    particleIndex: number,
  ): Matrix4 {
    this.applySampleOrientation(sample, emitter);
    this.scratchEuler.set(
      sample.rotation[0],
      sample.rotation[1],
      sample.rotation[2],
    );
    this.scratchRollQuaternion.setFromEuler(this.scratchEuler);
    this.scratchQuaternion.multiply(this.scratchRollQuaternion);
    this.scratchScale.set(
      sample.width,
      sample.height,
      emitter.mode === "mesh" && emitter.mesh.renderMode === "meshAsset"
        ? sample.depthScale
        : 1,
    );
    this.scratchWorld.set(
      sample.position[0] - this.context.position[0],
      sample.position[1] - this.context.position[1],
      sample.position[2] - this.context.position[2],
    );
    this.scratchMatrix.compose(
      this.scratchWorld,
      this.scratchQuaternion,
      this.scratchScale,
    );

    const pivotX =
      emitter.mode === "mesh"
        ? emitter.mesh.pivot[0] * view.pivotBoundsSize[0]
        : emitter.billboard.pivot[0] * view.pivotBoundsSize[0];
    const pivotY =
      emitter.mode === "mesh"
        ? emitter.mesh.pivot[1] * view.pivotBoundsSize[1]
        : emitter.billboard.pivot[1] * view.pivotBoundsSize[1];
    const pivotZ =
      emitter.mode === "mesh"
        ? emitter.mesh.pivot[2] * view.pivotBoundsSize[2]
        : 0; // billboard is a unit quad; pivotBoundsSize[2]=0 → Z inert (Vec2)
    if (pivotX !== 0 || pivotY !== 0 || pivotZ !== 0) {
      this.scratchPivotMatrix.makeTranslation(-pivotX, -pivotY, -pivotZ);
      this.scratchMatrix.multiply(this.scratchPivotMatrix);
    }

    if (this.context.captureDebugTransforms) {
      this.context.debugTransforms.push({
        emitterId: emitter.id,
        emitterIndex,
        particleIndex,
        mode:
          emitter.mode === "billboard"
            ? "billboard"
            : emitter.mesh.renderMode === "meshAsset"
              ? "meshAsset"
              : "pixiShard",
        position: [...sample.position] as Vec3,
        normal: [sample.normal.x, sample.normal.y, sample.normal.z],
        width: sample.width,
        height: sample.height,
        depth: sample.depth,
        localBounds: view.debugBounds,
        matrix: this.scratchMatrix.toArray(),
      });
    }
    return this.scratchMatrix;
  }

  acquireMesh(view: ThreeEmitterView, index: number): Mesh {
    let mesh = view.meshes[index];
    if (mesh) return mesh;
    // Share textures with the view material: a plain ShaderMaterial.clone()
    // deep-clones them and every new particle re-uploaded its textures.
    const material =
      view.material instanceof ShaderMaterial
        ? cloneShaderMaterialSharingTextures(view.material)
        : view.material.clone();
    mesh = new Mesh(view.geometry, material);
    mesh.frustumCulled = false;
    view.meshes[index] = mesh;
    this.context.root.add(mesh);
    return mesh;
  }
}
