import {
  MeshBasicMaterial,
  ShaderMaterial,
  Material,
  Texture,
  type Mesh,
} from "three";
import { isBillboardBatchSource } from "./billboardBatchSources";

export interface SurfaceProgram {
  key: string;
  id: number;
  fragment: string;
  uniforms: string[];
  types: string[];
  textures: Texture[];
  samplers: string[];
  kind: "graph" | "basic" | "billboard";
  vertexDynamicParams: boolean;
}
interface CachedSurfaceProgram {
  program: SurfaceProgram;
  fragment: string;
  vertex: string;
  map: Texture | null;
  alphaTest: number;
  toneMapped: boolean;
  premultipliedAlpha: boolean;
}
const cache = new WeakMap<object, CachedSurfaceProgram>();
let nextProgram = 0;
/** Only runtime graph shaders and the stock billboard contract are accepted. */
export function surfaceProgram(mesh: Mesh): SurfaceProgram | null {
  const m = mesh.material;
  if (Array.isArray(m)) return null;
  if (
    m instanceof ShaderMaterial &&
    !isBillboardBatchSource(mesh) &&
    m.userData.nixieSurfaceGraph !== true
  )
    return null;
  if (!(m instanceof MeshBasicMaterial) && !(m instanceof ShaderMaterial))
    return null;
  if (m.onBeforeCompile !== Material.prototype.onBeforeCompile) return null;
  if (
    m.clippingPlanes?.length ||
    m.stencilWrite ||
    m.polygonOffset ||
    m.alphaHash ||
    m.alphaToCoverage ||
    m.dithering ||
    m.wireframe
  )
    return null;
  if (
    m instanceof MeshBasicMaterial &&
    (m.alphaMap ||
      m.envMap ||
      m.lightMap ||
      m.aoMap ||
      (m.fog && mesh.userData.nixieSceneFog))
  )
    return null;
  if (
    m instanceof ShaderMaterial &&
    (m.lights || m.glslVersion !== null || Object.keys(m.defines).length > 0)
  )
    return null;
  if (m instanceof MeshBasicMaterial && m.map && m.map.channel !== 0)
    return null;
  if (m.fog) {
    for (let ancestor = mesh.parent; ancestor; ancestor = ancestor.parent) {
      if ("fog" in ancestor && ancestor.fog) return null;
    }
  }
  const fragmentSource = m instanceof ShaderMaterial ? m.fragmentShader : "";
  const vertexSource = m instanceof ShaderMaterial ? m.vertexShader : "";
  const map = m instanceof MeshBasicMaterial ? m.map : null;
  const old = cache.get(m);
  if (
    old &&
    old.fragment === fragmentSource &&
    old.vertex === vertexSource &&
    old.map === map &&
    old.alphaTest === m.alphaTest &&
    old.toneMapped === m.toneMapped &&
    old.premultipliedAlpha === m.premultipliedAlpha &&
    (!old.program.vertexDynamicParams ||
      !!mesh.geometry.getAttribute("trailDynamicParams")) &&
    old.program.textures.every(
      (t, i) =>
        t ===
        (m instanceof ShaderMaterial
          ? m.uniforms[old.program.samplers[i]!]?.value
          : m.map),
    ) &&
    old.program.uniforms.every((name, i) =>
      validUniformValue(m, name, old.program.types[i]!),
    )
  )
    return old.program;
  const kind = isBillboardBatchSource(mesh)
    ? "billboard"
    : m instanceof MeshBasicMaterial
      ? "basic"
      : "graph";
  const uniforms: string[] = [],
    types: string[] = [],
    textures: Texture[] = [],
    samplers: string[] = [];
  let fragment = "";
  let vertexDynamicParams = false;
  if (kind === "graph") {
    const shader = m as ShaderMaterial;
    const varyings = [
      ...shader.fragmentShader.matchAll(/varying\s+(\w+)\s+(\w+)\s*;/g),
    ];
    if (
      varyings.some(
        ([, type, name]) =>
          !(
            (type === "vec2" && name === "vUV") ||
            (type === "vec4" &&
              (name === "vColor" || name === "uDynamicParams"))
          ),
      )
    )
      return null;
    vertexDynamicParams = varyings.some(
      ([, , name]) => name === "uDynamicParams",
    );
    if (
      vertexDynamicParams &&
      !mesh.geometry.getAttribute("trailDynamicParams")
    )
      return null;
    fragment = shader.fragmentShader
      .replace(/precision\s+\w+\s+float\s*;/g, "")
      .replace(/varying\s+\w+\s+\w+\s*;/g, "");
    fragment = fragment.replace(
      /uniform\s+(\w+)\s+(\w+)\s*;/g,
      (_all, type: string, name: string) => {
        if (type === "sampler2D") {
          samplers.push(name);
          textures.push(shader.uniforms[name]?.value as Texture);
        } else {
          types.push(type);
          uniforms.push(name);
        }
        return "";
      },
    );
    if (
      types.some((t) => !["float", "vec2", "vec3", "vec4"].includes(t)) ||
      textures.some((t) => !t?.isTexture) ||
      uniforms.length > 16 ||
      uniforms.some((name, i) => !validUniformValue(shader, name, types[i]!)) ||
      /#include|#define|#if|\buniform\b|\bvarying\b/.test(fragment)
    )
      return null;
  } else {
    const texture =
      kind === "billboard"
        ? (m as ShaderMaterial).uniforms.uTexture?.value
        : (m as MeshBasicMaterial).map;
    if (texture) {
      textures.push(texture);
      samplers.push("uTexture");
    }
    fragment = `void main(){vec4 c=vNfxColor;${texture ? "c*=texture2D(uTexture,vUV);" : ""}${kind === "billboard" ? "if(c.a<=0.001)discard;" : ""}gl_FragColor=c;\n${kind === "basic" && m.toneMapped ? "#if defined(TONE_MAPPING)\ngl_FragColor.rgb=toneMapping(gl_FragColor.rgb);\n#endif\n" : ""}gl_FragColor=linearToOutputTexel(gl_FragColor);${kind === "basic" && m.premultipliedAlpha ? "gl_FragColor.rgb*=gl_FragColor.a;" : ""}}`;
    if (kind === "basic" && (m as MeshBasicMaterial).alphaTest > 0)
      fragment = fragment.replace(
        "gl_FragColor=",
        `if(c.a<${(m as MeshBasicMaterial).alphaTest.toFixed(8)})discard;gl_FragColor=`,
      );
  }
  const key =
    kind +
    String(vertexDynamicParams) +
    types.join(",") +
    fragment +
    textures.map((t) => t.uuid).join(",");
  const program = {
    key,
    id: nextProgram++,
    fragment,
    uniforms,
    types,
    textures,
    samplers,
    kind,
    vertexDynamicParams,
  } satisfies SurfaceProgram;
  cache.set(m, {
    program,
    fragment: fragmentSource,
    vertex: vertexSource,
    map,
    alphaTest: m.alphaTest,
    toneMapped: m.toneMapped,
    premultipliedAlpha: m.premultipliedAlpha,
  });
  return program;
}

export function compileSurfacePrograms(
  programs: readonly SurfaceProgram[],
  textures: readonly Texture[],
): string {
  let result =
    "precision mediump float;\nvarying vec2 vUV;\nvarying vec4 vNfxColor;\nvarying float vNfxProgram;\nvarying highp float vNfxDraw;\nvarying float vNfxFace;\nvarying vec4 vNfxDynamic;\n";
  result +=
    "uniform highp sampler2D uNfxData;\nvec4 nfxData(float slot){return texelFetch(uNfxData,ivec2(int(slot),int(vNfxDraw+0.5)),0); }\n";
  for (let i = 0; i < textures.length; i++)
    result += `uniform sampler2D nfxTexture${i};\n`;
  for (let i = 0; i < programs.length; i++) {
    const p = programs[i]!,
      replacements = new Map<string, string>();
    for (const match of p.fragment.matchAll(
      /\b(?:void|float|vec[234])\s+(\w+)\s*\(/g,
    ))
      replacements.set(match[1]!, `nfx${i}_${match[1]}`);
    p.samplers.forEach((name, j) =>
      replacements.set(name, `nfxTexture${textures.indexOf(p.textures[j]!)}`),
    );
    p.uniforms.forEach((name, j) =>
      replacements.set(
        name,
        `(nfxData(${j.toFixed(1)})${p.types[j] === "float" ? ".x" : p.types[j] === "vec2" ? ".xy" : p.types[j] === "vec3" ? ".xyz" : ""})`,
      ),
    );
    if (p.vertexDynamicParams)
      replacements.set("uDynamicParams", "vNfxDynamic");
    replacements.set("vColor", "vec4(vNfxColor.rgb*vNfxColor.a,vNfxColor.a)");
    result +=
      p.fragment.replace(
        /\b[A-Za-z_]\w*\b/g,
        (token) => replacements.get(token) ?? token,
      ) + "\n";
  }
  result +=
    "void main(){if(vNfxFace>0.5&&!gl_FrontFacing)discard;if(vNfxFace< -0.5&&gl_FrontFacing)discard;\n";
  programs.forEach((_p, i) => {
    result += `${i ? "else " : ""}if(vNfxProgram<${i + 0.5})nfx${i}_main();\n`;
  });
  return result + "}";
}

const VECTOR_COMPONENTS = ["x", "y", "z", "w"] as const;
function validUniformValue(
  material: Material,
  name: string,
  type: string,
): boolean {
  if (!(material instanceof ShaderMaterial)) return false;
  const value = material.uniforms[name]?.value;
  if (type === "float")
    return typeof value === "number" && Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  const count =
    type === "vec2" ? 2 : type === "vec3" ? 3 : type === "vec4" ? 4 : 0;
  if (!count) return false;
  for (let channel = 0; channel < count; channel++) {
    if (!Number.isFinite(value[VECTOR_COMPONENTS[channel]!])) return false;
  }
  return true;
}
