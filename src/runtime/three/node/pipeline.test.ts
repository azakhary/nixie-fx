import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  init: () => Promise.resolve(),
  native: true,
  stopped: vi.fn(),
  disposed: vi.fn(),
  lost: vi.fn(),
  updated: vi.fn(),
}));
vi.mock("three/webgpu", async (original) => ({
  ...(await original<object>()),
  WebGPURenderer: class {
    backend = {
      ...(state.native
        ? { isWebGPUBackend: true }
        : { gl: { getExtension: () => ({ loseContext: state.lost }) } }),
    };
    _animation = { stop: state.stopped };
    _nodes = { nodeFrame: { update: state.updated, frameId: 1 } };
    info = { autoReset: true, reset: vi.fn(), frame: 0 };
    toneMapping = 0;
    onDeviceLost?: unknown;
    init = () => state.init();
    dispose = state.disposed;
  },
}));
import {
  beginThreeWebGpuFrame,
  createThreeWebGpuRenderer,
  disposeThreeWebGpuRenderer,
} from "./pipeline";
beforeEach(() => {
  vi.clearAllMocks();
  state.native = true;
  state.init = () => Promise.resolve();
});
describe("host-owned renderer lifecycle", () => {
  it("stops Three's private heartbeat and advances only on an explicit frame", async () => {
    const { renderer, backend } = await createThreeWebGpuRenderer();
    expect(backend).toBe("webgpu");
    expect(state.stopped).toHaveBeenCalledOnce();
    expect(state.updated).not.toHaveBeenCalled();
    beginThreeWebGpuFrame(renderer);
    expect(state.updated).toHaveBeenCalledOnce();
    disposeThreeWebGpuRenderer(renderer);
    expect(state.disposed).toHaveBeenCalledOnce();
  });
  it("labels and releases the separate WebGL2 fallback context", async () => {
    state.native = false;
    const { renderer, backend } = await createThreeWebGpuRenderer({
      forceWebGL: true,
    });
    expect(backend).toBe("webgl2-fallback");
    disposeThreeWebGpuRenderer(renderer);
    expect(state.lost).toHaveBeenCalledOnce();
  });
  it("disposes late initialization after cancellation", async () => {
    let finish!: () => void;
    state.init = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const controller = new AbortController();
    const pending = createThreeWebGpuRenderer({ signal: controller.signal });
    controller.abort();
    finish();
    await expect(pending).rejects.toThrow();
    expect(state.disposed).toHaveBeenCalledOnce();
    expect(state.stopped).toHaveBeenCalledOnce();
  });
  it("releases initialization failures", async () => {
    state.init = () => Promise.reject(new Error("Adapter unavailable"));
    await expect(createThreeWebGpuRenderer()).rejects.toThrow(
      "Adapter unavailable",
    );
    expect(state.disposed).toHaveBeenCalledOnce();
  });
});
