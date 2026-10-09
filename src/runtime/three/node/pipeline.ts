import { NoToneMapping, type Camera, type Scene } from "three";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { sceneBloomToUnrealBloomParameters } from "../hdrEffectLayer";
import type { SceneDefinition } from "../../schema/scene";

export type ThreeActiveNodeBackend = "webgpu" | "webgl2-fallback";
/** The returned renderer belongs to the consumer. No animation loop is installed. */
export async function createThreeWebGpuRenderer(
  options: {
    forceWebGL?: boolean;
    canvas?: HTMLCanvasElement;
    onDeviceLost?: (message: string) => void;
    signal?: AbortSignal;
  } = {},
) {
  options.signal?.throwIfAborted();
  const renderer = new WebGPURenderer({
    antialias: true,
    alpha: false,
    forceWebGL: options.forceWebGL,
    canvas: options.canvas,
  });
  renderer.toneMapping = NoToneMapping;
  let lostMessage: string | undefined;
  renderer.onDeviceLost = (info) => {
    lostMessage = `Graphics device lost (${info.reason}): ${info.message}. Retry or select legacy WebGL.`;
    options.onDeviceLost?.(lostMessage);
  };
  try {
    await renderer.init();
    if (lostMessage) throw new Error(lostMessage);
    // r184 starts an internal bookkeeping rAF even without setAnimationLoop.
    // Stop that heartbeat: this package promises the host owns scheduling.
    manualFrameInternals(renderer)._animation.stop();
    options.signal?.throwIfAborted();
    const backend: ThreeActiveNodeBackend =
      "isWebGPUBackend" in renderer.backend && renderer.backend.isWebGPUBackend
        ? "webgpu"
        : "webgl2-fallback";
    return { renderer, backend };
  } catch (error) {
    disposeThreeWebGpuRenderer(renderer);
    throw error;
  }
}
/** Node post-processing, retaining HDR input and matching legacy bloom parameters. */
export class ThreeNodeRenderPipeline {
  private readonly scenePass;
  private readonly bloomPass;
  private readonly pipeline: RenderPipeline;
  private enabled = false;
  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly scene: Scene,
    private camera: Camera,
  ) {
    this.scenePass = pass(scene, camera);
    const color = this.scenePass.getTextureNode("output");
    this.bloomPass = bloom(color, 1, 0, 1);
    this.pipeline = new RenderPipeline(renderer, color.add(this.bloomPass));
  }
  setCamera(camera: Camera): void {
    this.camera = camera;
    this.scenePass.camera = camera;
  }
  setBloom(settings: SceneDefinition["bloom"]): void {
    const p = sceneBloomToUnrealBloomParameters(settings);
    this.enabled = p.enabled;
    this.bloomPass.strength.value = p.strength;
    this.bloomPass.radius.value = p.radius;
    this.bloomPass.threshold.value = p.threshold;
  }
  render(): void {
    beginThreeWebGpuFrame(this.renderer);
    if (this.enabled) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
  }
  dispose(): void {
    this.pipeline.dispose();
    this.bloomPass.dispose();
    this.scenePass.dispose();
  }
}

// This narrow compatibility seam is intentionally version-tested. Three has
// no public API to stop only its bookkeeping ticker in r184/r185.
interface ManualFrameInternals {
  info: { frame: number };
  _animation: { stop(): void };
  _nodes: { nodeFrame: { update(): void; frameId: number } };
}
function manualFrameInternals(renderer: WebGPURenderer): ManualFrameInternals {
  const internal = renderer as unknown as ManualFrameInternals;
  if (!internal._animation?.stop || !internal._nodes?.nodeFrame?.update)
    throw new Error(
      "This Three version cannot use host-owned WebGPU scheduling. Use Three r184/r185 or legacy WebGL.",
    );
  return internal;
}
/** Once before a host frame when rendering directly without ThreeNodeRenderPipeline. */
export function beginThreeWebGpuFrame(renderer: WebGPURenderer): void {
  const { _nodes } = manualFrameInternals(renderer);
  if (renderer.info.autoReset) renderer.info.reset();
  _nodes.nodeFrame.update();
  manualFrameInternals(renderer).info.frame = _nodes.nodeFrame.frameId;
}
/** Release backend resources and the browser's limited fallback context slot. */
export function disposeThreeWebGpuRenderer(renderer: WebGPURenderer): void {
  const backend = renderer.backend as unknown as {
    gl?: WebGL2RenderingContext;
  };
  renderer.dispose();
  backend.gl?.getExtension("WEBGL_lose_context")?.loseContext();
}
