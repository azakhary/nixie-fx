import {
  AdditiveBlending,
  Color,
  HalfFloatType,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Camera,
  type ColorRepresentation,
  type Object3D,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { normalizeSceneBloom, type SceneBloomSettings } from "../schema/scene";

/**
 * Scene bloom intensity (0..4) → UnrealBloomPass strength. The editor preview
 * and `createThreeHdrEffectLayer` share this mapping so a host reproduces the
 * glow the effect was authored against.
 */
const THREE_BLOOM_STRENGTH_SCALE = 0.25;

export interface ThreeUnrealBloomParameters {
  enabled: boolean;
  strength: number;
  radius: number;
  /** Luminance threshold; UnrealBloomPass works in 0..1. */
  threshold: number;
}

/** Options for `ThreeVfxRenderer` / `setPreviewBloomOptions`. */
export interface ThreeVfxSceneBloomOptions {
  enabled: boolean;
  threshold: number;
  exposureStops: number;
}

export function isSceneBloomActive(bloom: SceneBloomSettings): boolean {
  return bloom.enabled && bloom.intensity > 0;
}

export function sceneBloomToUnrealBloomParameters(
  bloom: SceneBloomSettings,
): ThreeUnrealBloomParameters {
  return {
    enabled: isSceneBloomActive(bloom),
    strength: clamp(bloom.intensity, 0, 4) * THREE_BLOOM_STRENGTH_SCALE,
    radius: clamp(bloom.scatter, 0, 1),
    threshold: clamp(bloom.threshold, 0, 1),
  };
}

/**
 * The particle renderer encodes emissive differently when bloom is on (hue
 * is kept for the glow instead of rolling toward white), so it must be told
 * about the same bloom the host composites.
 */
export function sceneBloomToThreeVfxOptions(
  bloom: SceneBloomSettings,
): ThreeVfxSceneBloomOptions {
  return {
    enabled: isSceneBloomActive(bloom),
    threshold: bloom.threshold,
    exposureStops: bloom.exposure,
  };
}

export interface ThreeHdrEffectLayerOptions {
  bloom: SceneBloomSettings;
  /**
   * The color the effects mostly sit on (usually the clear color). The
   * editor adds particles to the background in linear light; compositing
   * against the same backdrop keeps the result identical there.
   */
  backdrop?: ColorRepresentation;
  /** Drawing-buffer size in device pixels (defaults to the renderer's). */
  width?: number;
  height?: number;
}

/**
 * Renders effects the way the editor preview does, for hosts that draw their
 * own scene straight to the canvas:
 *
 *   layer.render(scene, camera, effectsRoot);
 *
 * `scene` is drawn first with `effectsRoot` hidden. The effects are then
 * blended in a linear HDR target (the editor's EffectComposer space — not the
 * canvas's 8-bit sRGB space, which thins soft particle edges and washes
 * stacked additive particles toward white), bloomed with the editor's
 * UnrealBloomPass mapping, and added to the canvas once.
 *
 * The effects are not depth-tested against the rest of the scene and render
 * without scene lights — meant for unlit additive/emissive particles.
 */
export interface ThreeHdrEffectLayer {
  readonly bloomActive: boolean;
  setBloom(bloom: SceneBloomSettings): void;
  setBackdrop(color: ColorRepresentation): void;
  setSize(width: number, height: number): void;
  render(scene: Object3D, camera: Camera, effects: Object3D): void;
  dispose(): void;
}

export function createThreeHdrEffectLayer(
  renderer: WebGLRenderer,
  options: ThreeHdrEffectLayerOptions,
): ThreeHdrEffectLayer {
  let settings = normalizeSceneBloom(options.bloom);
  const size = renderer.getDrawingBufferSize(new Vector2());
  const width = Math.max(1, Math.floor(options.width ?? size.x));
  const height = Math.max(1, Math.floor(options.height ?? size.y));
  const effectsTarget = new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
  });
  const initial = sceneBloomToUnrealBloomParameters(settings);
  const bloomPass = new UnrealBloomPass(
    new Vector2(width, height),
    initial.strength,
    initial.radius,
    initial.threshold,
  );
  bloomPass.setSize(width, height);
  const backdrop = new Color();
  const compositeMaterial = new ShaderMaterial({
    uniforms: {
      tEffects: { value: effectsTarget.texture },
      uBackdrop: { value: new Vector3() },
    },
    vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    // Adds encode(backdrop + effects) - encode(backdrop): exactly what the
    // editor's linear composite shows wherever the effects sit on the
    // backdrop, and never brighter than that over lighter scene pixels.
    fragmentShader: `
uniform sampler2D tEffects;
uniform vec3 uBackdrop;
varying vec2 vUv;
void main() {
  vec3 effects = texture2D(tEffects, vUv).rgb;
  vec3 lit = sRGBTransferOETF(vec4(min(uBackdrop + effects, vec3(1.0)), 1.0)).rgb;
  vec3 base = sRGBTransferOETF(vec4(uBackdrop, 1.0)).rgb;
  gl_FragColor = vec4(max(lit - base, vec3(0.0)), 1.0);
}`,
    blending: AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  });
  const compositeQuad = new FullScreenQuad(compositeMaterial);
  const previousClearColor = new Color();

  const applyBloom = () => {
    const params = sceneBloomToUnrealBloomParameters(settings);
    bloomPass.enabled = params.enabled;
    bloomPass.strength = params.strength;
    bloomPass.radius = params.radius;
    bloomPass.threshold = params.threshold;
  };
  const applyBackdrop = (color: ColorRepresentation) => {
    backdrop.set(color);
    compositeMaterial.uniforms.uBackdrop.value.set(
      backdrop.r,
      backdrop.g,
      backdrop.b,
    );
  };
  applyBloom();
  applyBackdrop(options.backdrop ?? 0x000000);

  return {
    get bloomActive() {
      return bloomPass.enabled;
    },
    setBloom(next) {
      settings = normalizeSceneBloom(next);
      applyBloom();
    },
    setBackdrop(color) {
      applyBackdrop(color);
    },
    setSize(nextWidth, nextHeight) {
      const w = Math.max(1, Math.floor(nextWidth));
      const h = Math.max(1, Math.floor(nextHeight));
      effectsTarget.setSize(w, h);
      bloomPass.setSize(w, h);
    },
    render(scene, camera, effects) {
      const effectsVisible = effects.visible;
      effects.visible = false;
      renderer.render(scene, camera);
      effects.visible = effectsVisible;
      if (!effectsVisible) return;

      const previousTarget = renderer.getRenderTarget();
      const previousAutoClear = renderer.autoClear;
      renderer.getClearColor(previousClearColor);
      const previousClearAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(effectsTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.autoClear = false;
      renderer.render(effects, camera);
      // Leaves effects + glow in effectsTarget.
      if (bloomPass.enabled) {
        bloomPass.render(renderer, effectsTarget, effectsTarget, 0, false);
      }
      renderer.setRenderTarget(previousTarget);
      compositeQuad.render(renderer);
      renderer.autoClear = previousAutoClear;
      renderer.setClearColor(previousClearColor, previousClearAlpha);
    },
    dispose() {
      effectsTarget.dispose();
      bloomPass.dispose();
      compositeMaterial.dispose();
      compositeQuad.dispose();
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
