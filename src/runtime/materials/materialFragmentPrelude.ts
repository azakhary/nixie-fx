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
