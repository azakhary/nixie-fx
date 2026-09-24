export const MATERIAL_FRAGMENT_HEADER = `
precision mediump float;

varying vec2 vUV;
varying vec4 vColor;

uniform sampler2D uTexture;
uniform float uTime;
uniform vec4 uFixedTint;
uniform float uFixedEmissive;
uniform float uFixedOpacity;
uniform float uClipValue;
uniform vec2 uSheetTiles;
uniform vec4 uSubUv;
uniform float uSubUvFromAttr;
uniform vec4 uDynamicParams;

float materialLuminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float materialHash(vec2 p, float seed) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + seed * 0.00317);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float materialValueNoise(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = materialHash(i, seed);
  float b = materialHash(i + vec2(1.0, 0.0), seed);
  float c = materialHash(i + vec2(0.0, 1.0), seed);
  float d = materialHash(i + vec2(1.0, 1.0), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float materialGradientNoise(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a0 = materialHash(i, seed) * 6.2831853;
  float a1 = materialHash(i + vec2(1.0, 0.0), seed) * 6.2831853;
  float a2 = materialHash(i + vec2(0.0, 1.0), seed) * 6.2831853;
  float a3 = materialHash(i + vec2(1.0, 1.0), seed) * 6.2831853;
  float n00 = dot(vec2(cos(a0), sin(a0)), f);
  float n10 = dot(vec2(cos(a1), sin(a1)), f - vec2(1.0, 0.0));
  float n01 = dot(vec2(cos(a2), sin(a2)), f - vec2(0.0, 1.0));
  float n11 = dot(vec2(cos(a3), sin(a3)), f - vec2(1.0, 1.0));
  return clamp(mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y) * 0.7071 + 0.5, 0.0, 1.0);
}

float materialVoronoiNoise(vec2 p, float seed) {
  vec2 i = floor(p);
  float minD = 100000.0;
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 cell = i + vec2(float(ox), float(oy));
      vec2 feature = cell + vec2(
        materialHash(cell, seed),
        materialHash(cell, seed + 37.719)
      );
      vec2 diff = feature - p;
      minD = min(minD, dot(diff, diff));
    }
  }
  return min(1.0, sqrt(minD));
}

float materialScalarNoise(vec2 uv, float scale, float seed, float outputMin, float outputMax, float mode) {
  vec2 p = uv * max(scale, 0.0001);
  float n = mode > 1.5
    ? materialVoronoiNoise(p, seed)
    : (mode > 0.5 ? materialValueNoise(p, seed) : materialGradientNoise(p, seed));
  return mix(outputMin, outputMax, n);
}

vec4 materialSampleMain(vec2 uv) {
  return texture2D(uTexture, uSubUv.xy + fract(uv) * uSubUv.zw);
}

vec4 materialSampleSubUvBlend(vec2 uv) {
  vec4 current = materialSampleMain(uv);
  if (uSubUvFromAttr > 0.5) return current;
  vec2 tiles = max(floor(uSheetTiles + 0.5), vec2(1.0, 1.0));
  float total = max(1.0, tiles.x * tiles.y);
  if (total <= 1.0) return current;
  vec2 scaled = (uSubUv.xy + fract(uv) * uSubUv.zw) * tiles;
  vec2 cell = floor(scaled);
  vec2 local = fract(scaled);
  float frame = mod((tiles.y - 1.0 - cell.y) * tiles.x + cell.x, total);
  float nextFrame = mod(frame + 1.0, total);
  vec2 nextCell = vec2(
    mod(nextFrame, tiles.x),
    tiles.y - 1.0 - floor(nextFrame / tiles.x)
  );
  vec2 nextUv = (nextCell + local) / tiles;
  return mix(current, texture2D(uTexture, nextUv), clamp(vColor.a, 0.0, 1.0));
}
`;

/**
 * Scene-lighting helpers, emitted only for lit graphs or graphs that read
 * lighting nodes. The host selects the light source with a define placed
 * before the fragment:
 *  - `NFX_SCENE_LIGHTS`   Three.js: real scene lights (`lights: true`, the
 *    host also includes <common> + <lights_pars_begin> and the lit varyings).
 *  - `NFX_PREVIEW_LIGHTS` 2D material previews: the stock key/fill/gradient
 *    lights of the default scene, with a camera-facing surface.
 *  - neither (Pixi):      lit shading passes BaseColor through unlit and the
 *    lighting nodes return neutral values (full light, no ambient).
 *
 * Light-node outputs are "multiply-ready": BaseColor * MainLightColor *
 * saturate(dot(N, L)) equals the diffuse term the Lit shading model computes
 * (Three's Lambert BRDF already divides by PI).
 */
export const MATERIAL_LIGHTING_PRELUDE = `
const float NFX_RECIPROCAL_PI = 0.3183098861837907;

#ifdef NFX_SCENE_LIGHTS
varying vec3 vNfxViewPosition;
varying vec3 vNfxViewNormal;
varying vec3 vNfxWorldPosition;

vec3 nfxGeometryViewNormal() {
  vec3 n = normalize(vNfxViewNormal);
  return gl_FrontFacing ? n : -n;
}
vec3 nfxViewPosition() { return -vNfxViewPosition; }
vec3 nfxViewDirectionView() {
  return isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vNfxViewPosition);
}
vec3 nfxViewToWorld(vec3 v) { return normalize((vec4(v, 0.0) * viewMatrix).xyz); }
vec3 nfxWorldPosition() { return vNfxWorldPosition; }
vec3 nfxApplyTangentNormal(vec3 n, vec3 tangentNormal) {
  vec3 p = -vNfxViewPosition;
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 duv1 = dFdx(vUV);
  vec2 duv2 = dFdy(vUV);
  vec3 dp2perp = cross(dp2, n);
  vec3 dp1perp = cross(n, dp1);
  vec3 t = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 b = dp2perp * duv1.y + dp1perp * duv2.y;
  float det = max(dot(t, t), dot(b, b));
  if (det <= 0.0) return n;
  float scale = inversesqrt(det) * (gl_FrontFacing ? 1.0 : -1.0);
  return normalize(mat3(t * scale, b * scale, n) * tangentNormal);
}
#else
vec3 nfxGeometryViewNormal() { return vec3(0.0, 0.0, 1.0); }
vec3 nfxViewPosition() { return vec3(vUV * 2.0 - 1.0, 0.0); }
vec3 nfxViewDirectionView() { return vec3(0.0, 0.0, 1.0); }
vec3 nfxViewToWorld(vec3 v) { return v; }
vec3 nfxWorldPosition() { return vec3(vUV - 0.5, 0.0); }
vec3 nfxApplyTangentNormal(vec3 n, vec3 tangentNormal) {
  return normalize(tangentNormal);
}
#endif

vec3 nfxMainLightDirectionView() {
#ifdef NFX_SCENE_LIGHTS
#if NUM_DIR_LIGHTS > 0
  return directionalLights[0].direction;
#else
  return normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
#endif
#elif defined(NFX_PREVIEW_LIGHTS)
  return normalize(vec3(3.0, 6.0, 5.0));
#else
  return vec3(0.0, 0.0, 1.0);
#endif
}

vec3 nfxMainLightColor() {
#ifdef NFX_SCENE_LIGHTS
#if NUM_DIR_LIGHTS > 0
  return directionalLights[0].color * NFX_RECIPROCAL_PI;
#else
  return vec3(0.0);
#endif
#elif defined(NFX_PREVIEW_LIGHTS)
  return vec3(2.2 * NFX_RECIPROCAL_PI);
#else
  return vec3(1.0);
#endif
}

vec3 nfxAmbientIrradiance(vec3 viewNormal) {
#ifdef NFX_SCENE_LIGHTS
  vec3 irradiance = ambientLightColor;
#if NUM_HEMI_LIGHTS > 0
  for (int i = 0; i < NUM_HEMI_LIGHTS; i++) {
    irradiance += getHemisphereLightIrradiance(hemisphereLights[i], viewNormal);
  }
#endif
  return irradiance;
#elif defined(NFX_PREVIEW_LIGHTS)
  float w = 0.5 * viewNormal.y + 0.5;
  return mix(vec3(0.0823, 0.1170, 0.1590), vec3(0.9301, 0.9473, 1.0), w) * 1.15;
#else
  return vec3(0.0);
#endif
}

vec3 nfxSpecularGGX(vec3 l, vec3 v, vec3 n, vec3 f0, float roughness) {
  float alpha = max(roughness * roughness, 0.0025);
  vec3 h = normalize(l + v);
  float dotNL = clamp(dot(n, l), 0.0, 1.0);
  float dotNV = clamp(dot(n, v), 0.0, 1.0);
  float dotNH = clamp(dot(n, h), 0.0, 1.0);
  float dotVH = clamp(dot(v, h), 0.0, 1.0);
  vec3 fresnel = f0 + (vec3(1.0) - f0) * pow(1.0 - dotVH, 5.0);
  float a2 = alpha * alpha;
  float visV = dotNL * sqrt(a2 + (1.0 - a2) * dotNV * dotNV);
  float visL = dotNV * sqrt(a2 + (1.0 - a2) * dotNL * dotNL);
  float visibility = 0.5 / max(visV + visL, 0.000001);
  float denom = dotNH * dotNH * (a2 - 1.0) + 1.0;
  float distribution = NFX_RECIPROCAL_PI * a2 / max(denom * denom, 0.000001);
  return fresnel * (visibility * distribution);
}

vec3 nfxLightContribution(vec3 l, vec3 color, vec3 n, vec3 v, vec3 diffuseColor, vec3 f0, float roughness, float specular) {
  float dotNL = clamp(dot(n, l), 0.0, 1.0);
  vec3 irradiance = dotNL * color;
  return irradiance * (diffuseColor * NFX_RECIPROCAL_PI + specular * nfxSpecularGGX(l, v, n, f0, roughness));
}

vec3 nfxShadeSurface(vec3 albedo, vec3 n, vec3 v, vec3 p, float roughness, float metallic, float specular) {
  vec3 diffuseColor = albedo * (1.0 - metallic);
  vec3 f0 = mix(vec3(0.04), albedo, metallic);
  vec3 color = vec3(0.0);
#ifdef NFX_SCENE_LIGHTS
  IncidentLight light;
#if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
    getDirectionalLightInfo(directionalLights[i], light);
    color += nfxLightContribution(light.direction, light.color, n, v, diffuseColor, f0, roughness, specular);
  }
#endif
#if NUM_POINT_LIGHTS > 0
  for (int i = 0; i < NUM_POINT_LIGHTS; i++) {
    getPointLightInfo(pointLights[i], p, light);
    if (light.visible) color += nfxLightContribution(light.direction, light.color, n, v, diffuseColor, f0, roughness, specular);
  }
#endif
#if NUM_SPOT_LIGHTS > 0
  for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
    getSpotLightInfo(spotLights[i], p, light);
    if (light.visible) color += nfxLightContribution(light.direction, light.color, n, v, diffuseColor, f0, roughness, specular);
  }
#endif
#elif defined(NFX_PREVIEW_LIGHTS)
  color += nfxLightContribution(normalize(vec3(3.0, 6.0, 5.0)), vec3(2.2), n, v, diffuseColor, f0, roughness, specular);
  color += nfxLightContribution(normalize(vec3(-4.0, 2.5, -3.0)), vec3(0.3467, 0.4851, 1.0) * 0.55, n, v, diffuseColor, f0, roughness, specular);
#endif
  color += nfxAmbientIrradiance(n) * diffuseColor * NFX_RECIPROCAL_PI;
  return color;
}

/** Lit shading model: BaseColor lit by the scene (unlit passthrough on Pixi). */
vec3 nfxShadeLit(vec3 albedo, vec3 tangentNormal, float roughness, float metallic) {
#if defined(NFX_SCENE_LIGHTS) || defined(NFX_PREVIEW_LIGHTS)
  vec3 n = nfxApplyTangentNormal(nfxGeometryViewNormal(), tangentNormal);
  return nfxShadeSurface(albedo, n, nfxViewDirectionView(), nfxViewPosition(), clamp(roughness, 0.0, 1.0), clamp(metallic, 0.0, 1.0), 1.0);
#else
  return albedo;
#endif
}

/** Diffuse irradiance (direct + ambient) at the surface, multiply-ready. */
vec3 nfxDiffuseLighting() {
#if defined(NFX_SCENE_LIGHTS) || defined(NFX_PREVIEW_LIGHTS)
  vec3 n = nfxGeometryViewNormal();
  return nfxShadeSurface(vec3(1.0), n, nfxViewDirectionView(), nfxViewPosition(), 1.0, 0.0, 0.0);
#else
  return vec3(1.0);
#endif
}

/** Normal-map texel (0..1) to a tangent-space normal, Unity "Normal Unpack". */
vec4 nfxUnpackNormal(vec4 texel, float strength) {
  vec3 n = texel.xyz * 2.0 - 1.0;
  n.xy *= strength;
  return vec4(normalize(vec3(n.xy, max(n.z, 0.0001))), 1.0);
}

vec3 nfxAmbientColor() {
  return nfxAmbientIrradiance(nfxGeometryViewNormal()) * NFX_RECIPROCAL_PI;
}
`;

/** Define that makes a lit/lighting-node fragment use the stock preview lights. */
export const MATERIAL_PREVIEW_LIGHTS_DEFINE = "#define NFX_PREVIEW_LIGHTS\n";
