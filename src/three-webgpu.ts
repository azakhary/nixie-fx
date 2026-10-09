/** Opt-in node material path. CPU simulation and Three light ownership are shared. */
export { createThreeNodeAdapter } from "./runtime/three/node/adapter";
export {
  compileThreeNodeGraph,
  ThreeNodeMaterialError,
} from "./runtime/three/node/graph";
export type { ThreeNodeGraphInputs } from "./runtime/three/node/graph";
export {
  createThreeWebGpuRenderer,
  beginThreeWebGpuFrame,
  disposeThreeWebGpuRenderer,
  ThreeNodeRenderPipeline,
} from "./runtime/three/node/pipeline";
export type { ThreeActiveNodeBackend } from "./runtime/three/node/pipeline";
