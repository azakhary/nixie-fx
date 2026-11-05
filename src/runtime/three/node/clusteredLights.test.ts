import { describe, expect, it, vi } from "vitest";
import { Scene, DirectionalLight } from "three";
import { Lighting, type WebGPURenderer } from "three/webgpu";
import { createThreeClusteredLighting } from "./clusteredLights";

describe("initialized renderer lighting binding", () => {
  it("wraps the captured factory, delegates other scenes and restores it on disposal", () => {
    const lighting = new Lighting(),
      disposeLists = vi.fn();
    const renderer = {
      backend: { isWebGPUBackend: true },
      lighting,
      _renderLists: { dispose: disposeLists },
    } as unknown as WebGPURenderer;
    const scene = new Scene(),
      other = new Scene(),
      original = lighting.getNode;
    const gameLight = new DirectionalLight();
    scene.add(gameLight);
    const binding = createThreeClusteredLighting(renderer, scene);
    expect(renderer.lighting).toBe(lighting); // captured during Three.init()
    expect(disposeLists).toHaveBeenCalledTimes(1);
    expect(lighting.getNode(scene).hasLights).toBe(true);
    const sceneNode = lighting.getNode(scene);
    sceneNode.setLights([gameLight]);
    const augmented = lighting.createNode([...sceneNode.getLights()]);
    expect(augmented.getLights()).toHaveLength(2);
    expect(augmented.getLights()[0]).toBe(gameLight);
    expect(augmented.getLights()[1]).toHaveProperty("isLightingNode", true);
    expect(lighting.getNode(other)).toBe(original.call(lighting, other));
    expect(() => createThreeClusteredLighting(renderer, scene)).toThrow(
      "already",
    );
    binding.dispose();
    binding.dispose();
    expect(lighting.getNode).toBe(original);
    expect(disposeLists).toHaveBeenCalledTimes(2);
    expect(gameLight.parent).toBe(scene);
    expect(binding.manager.stats.mode).toBe("small");
    binding.manager.dispose();
    const next = createThreeClusteredLighting(renderer, scene);
    next.dispose();
    next.manager.dispose();
  });
  it("never installs clustered shading for WebGL2 fallback", () => {
    const lighting = new Lighting(),
      original = lighting.getNode;
    const renderer = {
      backend: { isWebGLBackend: true },
      lighting,
    } as unknown as WebGPURenderer;
    const binding = createThreeClusteredLighting(renderer, new Scene());
    binding.manager.setProfile({
      mode: "clustered",
      maxLights: 128,
      totalSceneLights: 128,
      maxLightsPerCluster: 16,
    });
    expect(binding.supported).toBe(false);
    expect(binding.reason).toContain("WebGL2");
    expect(binding.manager.stats.mode).toBe("small");
    expect(lighting.getNode).toBe(original);
    binding.dispose();
    binding.manager.dispose();
  });
});
