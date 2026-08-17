import * as THREE from "three";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import type { NixieGlowPalette } from "./glowPalette";

export interface StudioEnvironmentHandle {
  /**
   * Re-bakes the PMREM environment after the glow palette recolored the env
   * scene's warm cards (the orange sheen on the glass sides lives in these
   * baked reflections). Throttled so color-picker drags don't bake per event.
   */
  requestRefresh: () => void;
  dispose: () => void;
}

const ENV_REFRESH_MIN_INTERVAL_MS = 150;

export function applyStudioEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  glowPalette?: NixieGlowPalette,
): StudioEnvironmentHandle {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = createEnvScene(glowPalette);
  let current = pmrem.fromScene(envScene, 0.03);
  scene.environment = current.texture;
  scene.environmentIntensity = 1.0;

  let disposed = false;
  let pending = false;
  let lastBake = 0;
  const bake = () => {
    if (disposed) return;
    lastBake = performance.now();
    const next = pmrem.fromScene(envScene, 0.03);
    scene.environment = next.texture;
    current.dispose();
    current = next;
  };
  return {
    requestRefresh: () => {
      if (disposed || pending) return;
      pending = true;
      const wait = Math.max(
        0,
        ENV_REFRESH_MIN_INTERVAL_MS - (performance.now() - lastBake),
      );
      setTimeout(() => {
        pending = false;
        bake();
      }, wait);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      scene.environment = null;
      disposeEnvScene(envScene);
      current.dispose();
      pmrem.dispose();
    },
  };
}

export function addStudioWorld(
  scene: THREE.Scene,
  glowPalette?: NixieGlowPalette,
): void {
  const shell = createGradientShell();
  const uniforms = (shell.material as THREE.ShaderMaterial).uniforms;
  glowPalette?.register(
    uniforms.topColor.value as THREE.Color,
    uniforms.bottomColor.value as THREE.Color,
  );
  scene.add(shell);
}

export function addStudioLights(
  scene: THREE.Scene,
  glowPalette?: NixieGlowPalette,
): THREE.PointLight {
  RectAreaLightUniformsLib.init();

  // warm-white LED panel on the ceiling — long soft speculars on glass/copper
  const ceiling = new THREE.RectAreaLight(0xf3ead9, 5.5, 4.5, 1.0);
  ceiling.position.set(0.4, 7.0, 1.4);
  ceiling.lookAt(0, 1.6, 0);
  scene.add(ceiling);

  // tall window key, front-left — reaches down to the copper base
  const windowLight = new THREE.RectAreaLight(0xf7f0e2, 7, 1.6, 6.4);
  windowLight.position.set(-4.4, 2.6, 4.8);
  windowLight.lookAt(0, 1.8, 0);
  scene.add(windowLight);

  // The cream key lights carry the room's warmth — they follow the picker
  // (the cool right-side fill stays put as the neutral counter-tint).
  glowPalette?.register(ceiling.color, windowLight.color);

  // faint cool fill from the right
  const fill = new THREE.RectAreaLight(0xb9c2d4, 1.4, 2.6, 2.2);
  fill.position.set(4.6, 2.6, 2.8);
  fill.lookAt(0, 1.8, 0);
  scene.add(fill);

  // faint warm ambience — nothing in the scene should ever hit true black
  const ambient = new THREE.AmbientLight(0x6b4a2e, 0.35);
  scene.add(ambient);

  // neon spill from the lit digit
  const neon = new THREE.PointLight(0xff4a0e, 3.0, 5.5, 2.0);
  neon.position.set(0, 1.98, 0.1);
  scene.add(neon);
  glowPalette?.register(neon.color, ambient.color);
  return neon;
}

function createEnvScene(glowPalette?: NixieGlowPalette): THREE.Scene {
  const env = new THREE.Scene();
  // The warm (wolfram-derived) env content follows the Nixie Color picker;
  // the neutral studio strips/softboxes stay put. IMPORTANT: register the
  // MATERIAL's own color instance — material constructors COPY the color
  // option, so registering the constructor argument would mutate a dead
  // Color while the baked env kept its authored warmth. The owner re-bakes
  // PMREM after each palette change (see applyStudioEnvironment).
  const warm = (mesh: THREE.Mesh): THREE.Mesh => {
    glowPalette?.register((mesh.material as THREE.MeshBasicMaterial).color);
    return mesh;
  };

  // warm dark-brown base level: every reflection direction returns at least
  // this, so polished copper never reads pitch black
  const shell = warm(
    new THREE.Mesh(
      new THREE.BoxGeometry(24, 16, 24),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(0.085, 0.055, 0.038),
        side: THREE.BackSide,
      }),
    ),
  );
  env.add(shell);

  // bright ceiling LED strip (HDR)
  const ceilingCard = card(4.5, 1.0, new THREE.Color(7, 7.2, 7.6));
  ceilingCard.position.set(0.4, 7.2, 1.3);
  ceilingCard.rotation.x = Math.PI / 2;
  env.add(ceilingCard);

  // tall thin window strip — the long vertical streak in glass and copper,
  // extends far below the horizon so the base collar catches it too
  const windowCard = card(1.4, 9.5, new THREE.Color(6, 6, 6.2));
  windowCard.position.set(-5.0, 1.8, 5.6);
  windowCard.lookAt(0, 1.6, 0);
  env.add(windowCard);

  // narrower strips at several azimuths — vertical streaks on copper/glass
  // from any orbit angle
  const stripSpecs: Array<[number, number, THREE.Color]> = [
    [0.9, 4.4, new THREE.Color(3.0, 3.0, 3.2)],
    [2.6, 5.2, new THREE.Color(1.7, 1.7, 1.8)],
    [3.9, 4.0, new THREE.Color(3.4, 3.4, 3.6)],
    [-2.2, 4.8, new THREE.Color(1.3, 1.3, 1.4)],
  ];
  for (const [azimuth, distance, color] of stripSpecs) {
    const strip = card(0.5, 9.0, color);
    strip.position.set(
      Math.sin(azimuth) * distance,
      1.8,
      Math.cos(azimuth) * distance,
    );
    strip.lookAt(0, 1.6, 0);
    env.add(strip);
  }

  // faint cool card, camera-right
  const fillCard = card(3.0, 2.2, new THREE.Color(0.35, 0.38, 0.45));
  fillCard.position.set(6, 2.2, 2.8);
  fillCard.lookAt(0, 1.5, 0);
  env.add(fillCard);

  // warm mid-tone content filling the collar's reflection angles all around —
  // the photo's collar mirrors a warm-lit deck, not a black void, so its
  // bands are soft brownish gradations rather than hard black/orange stripes
  for (const az of [0.4, 1.6, 2.8, 4.0, 5.2]) {
    const deck = warm(card(4.6, 3.4, new THREE.Color(0.5, 0.27, 0.11)));
    deck.position.set(Math.sin(az) * 4.4, -0.4, Math.cos(az) * 4.4);
    deck.lookAt(0, 0.9, 0);
    env.add(deck);
  }

  // faint reddish ring at cage height so the mesh carries the warm tint from
  // every viewing direction (gaps read as dead unlit sides)
  for (let i = 0; i < 6; i++) {
    const az = (i / 6) * Math.PI * 2 + 0.3;
    const tint = warm(card(3.2, 2.6, new THREE.Color(0.34, 0.12, 0.035)));
    tint.position.set(Math.sin(az) * 5.0, 2.0, Math.cos(az) * 5.0);
    tint.lookAt(0, 2.0, 0);
    env.add(tint);
  }

  // broad soft white panels — the collar in the photo is mostly bright
  // because it mirrors a big softbox, not just thin strips
  for (const az of [0.7, 2.8, -1.5]) {
    const soft = card(2.6, 5.5, new THREE.Color(1.35, 1.32, 1.28));
    soft.position.set(Math.sin(az) * 6.2, 1.6, Math.cos(az) * 6.2);
    soft.lookAt(0, 1.5, 0);
    env.add(soft);
  }

  // very dim warm rear card so the back of the tube isn't dead black
  const rearSoft = warm(card(7, 5, new THREE.Color(0.16, 0.13, 0.11)));
  rearSoft.position.set(0, 3.2, -8);
  env.add(rearSoft);

  return env;
}

function createGradientShell(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x221c16) },
      bottomColor: { value: new THREE.Color(0x0e0b08) },
    },
    vertexShader: `
      varying float vY;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vY = world.y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying float vY;
      void main() {
        float t = smoothstep(-1.4, 8.5, vY);
        gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(26, 48, 32), material);
  mesh.position.y = 3.2;
  mesh.frustumCulled = false;
  return mesh;
}

function card(w: number, h: number, color: THREE.Color): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ color }),
  );
}

function disposeEnvScene(scene: THREE.Scene): void {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}
