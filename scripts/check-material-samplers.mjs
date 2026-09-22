import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Run headed on the target GPU. Example:
// node scripts/check-material-samplers.mjs --angle=d3d11 --executable=/path/to/chrome
const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const source = await readFile(
  new URL(
    "../src/runtime/materials/materialFragmentPrelude.ts",
    import.meta.url,
  ),
  "utf8",
);
const header = source.slice(source.indexOf("`") + 1, source.lastIndexOf("`"));
const browser = await chromium.launch({
  headless: process.argv.includes("--headless"),
  ...(option("executable") ? { executablePath: option("executable") } : {}),
  args: option("angle") ? [`--use-angle=${option("angle")}`] : [],
});
try {
  const page = await browser.newPage();
  const result = await page.evaluate((header) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 unavailable");
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const vertex = compile(
      gl.VERTEX_SHADER,
      `#version 300 es
out vec2 vUV; out vec4 vColor;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p; vColor = vec4(1.0); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`,
    );
    const pixels = [];
    for (const premultiplied of [false, true]) {
      const fragment = compile(
        gl.FRAGMENT_SHADER,
        `#version 300 es
precision highp float;
precision highp sampler2D;
#define varying in
#define texture2D texture
out vec4 resultColor;
#define gl_FragColor resultColor
${premultiplied ? "#define MATERIAL_TEXTURE_PREMULTIPLIED" : ""}
${header}
uniform sampler2D firstTexture;
uniform sampler2D secondTexture;
void main() {
  gl_FragColor = materialTextureSample(secondTexture,
    vec2(materialTextureSample(firstTexture, vec2(0.5)).r, 0.5));
}`,
      );
      const program = gl.createProgram();
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const textures = [];
      for (const [unit, name, data] of [
        [0, "firstTexture", [64, 64, 64, 255]],
        [
          1,
          "secondTexture",
          premultiplied ? [0, 0, 64, 128] : [0, 0, 255, 255],
        ],
      ]) {
        const texture = gl.createTexture();
        textures.push(texture);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          1,
          1,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          new Uint8Array(data),
        );
        gl.uniform1i(gl.getUniformLocation(program, name), unit);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const pixel = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      pixels.push({
        premultiplied,
        pixel: Array.from(pixel),
        error: gl.getError(),
      });
      textures.forEach((texture) => gl.deleteTexture(texture));
      gl.deleteProgram(program);
      gl.deleteShader(fragment);
    }
    gl.deleteShader(vertex);
    return { renderer, pixels };
  }, header);
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(
    result.pixels[0].pixel,
    [0, 0, 255, 255],
    "Nested reads must use the outer sampler",
  );
  assert.ok(
    result.pixels[1].pixel.every(
      (value, index) => Math.abs(value - [0, 0, 128, 128][index]) <= 1,
    ),
    "Premultiplied input must still decode once",
  );
  assert.ok(
    result.pixels.every((entry) => entry.error === 0),
    "WebGL error",
  );
} finally {
  await browser.close();
}
