import * as THREE from "three";
import { getHexAlphaTexture } from "./honeycomb";

export function createCopperMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.88, 0.52, 0.32),
    metalness: 1,
    roughness: 0.13,
    envMapIntensity: 1.6,
  });
}

/**
 * Cheap two-shell glass (no transmission pass, which would hide the additive
 * glow sprite/halos behind it):
 *  - body: a faint dark tint film
 *  - reflection shell: black physical material drawn additively, so ONLY the
 *    env/light speculars survive — crisp streaks + fresnel rim, no gray haze
 */
export function createGlassBodyMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0x08080a,
    transparent: true,
    opacity: 0.09,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

export function createGlassReflectionMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    metalness: 0,
    roughness: 0.025,
    envMapIntensity: 1.0,
    specularIntensity: 0.4,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

export function createCageMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.23, 0.185, 0.15),
    metalness: 0.5,
    roughness: 0.72,
    envMapIntensity: 0.11,
    alphaMap: getHexAlphaTexture(),
    // sub-1 opacity + alphaToCoverage = MSAA translucency: the wires read
    // lighter/less blocking with none of the transparent-sorting issues
    opacity: 0.62,
    alphaTest: 0.28,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
  });
}

export function createChromeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.17, 0.16, 0.15),
    metalness: 1,
    roughness: 0.62,
    envMapIntensity: 0.2,
  });
}

export function createCeramicMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.78, 0.76, 0.72),
    metalness: 0,
    roughness: 0.6,
    envMapIntensity: 0.4,
  });
}

export function createDigitMetalMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.13, 0.11, 0.095),
    metalness: 0.7,
    roughness: 0.55,
    envMapIntensity: 0.3,
  });
}

/**
 * Self-luminous plasma sheath: narrow amber core where the tube faces the
 * viewer, saturated red-orange at the silhouette. Brightness AND color
 * temperature ride the baked `aIntensity` attribute (see digits.ts): hot
 * spans push toward amber, weak spans cool off toward deep red — never
 * toward white, matching the reference tube.
 */
export function createPlasmaMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      // linear-space values of the target sRGB hues (#ff4400 edge, #ffa855
      // hot core, #d43000 cold spans) — tonemapping is skipped for this
      // material because ACES crosstalk desaturates orange toward yellow
      edgeColor: { value: new THREE.Color(1.0, 0.058, 0.0) },
      coreColor: { value: new THREE.Color(1.0, 0.391, 0.091) },
      dimColor: { value: new THREE.Color(0.658, 0.03, 0.0) },
    },
    vertexShader: `
      attribute float aIntensity;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vIntensity;
      void main() {
        vNormal = normalMatrix * normal;
        vIntensity = aIntensity;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 edgeColor;
      uniform vec3 coreColor;
      uniform vec3 dimColor;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vIntensity;
      void main() {
        float f = pow(max(dot(normalize(vNormal), normalize(vView)), 0.0), 5.0);
        float heat = smoothstep(0.75, 1.25, vIntensity);
        vec3 col = mix(edgeColor, coreColor, f * (0.5 + 0.5 * heat));
        col = mix(dimColor, col, smoothstep(0.55, 0.95, vIntensity));
        col *= vIntensity;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * Haze hugging the lit digit. Deep red — cooler and more desaturated than
 * the sheath edge, the way a real neon halo falls off — fading at the tube
 * silhouette and breathing along the stroke via the baked intensity.
 */
export function createGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(1.0, 0.09, 0.008) },
      uOpacity: { value: 0.32 },
    },
    vertexShader: `
      attribute float aIntensity;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vIntensity;
      void main() {
        vNormal = normalMatrix * normal;
        vIntensity = aIntensity;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vIntensity;
      void main() {
        float facing = pow(max(dot(normalize(vNormal), normalize(vView)), 0.0), 1.6);
        gl_FragColor = vec4(uColor * vIntensity, uOpacity * facing * vIntensity);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

export function createNickelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.1, 0.095, 0.09),
    metalness: 1,
    roughness: 0.75,
    envMapIntensity: 0.12,
  });
}

export function createRadialGlowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.38)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.08)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
