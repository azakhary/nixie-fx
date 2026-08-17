import * as THREE from "three";
import { createDigitGeometry } from "./digits";
import type { NixieGlowPalette } from "./glowPalette";
import { createCageWallGeometry, createCapPlateGeometry } from "./honeycomb";
import {
  createCageMaterial,
  createChromeMaterial,
  createCopperMaterial,
  createDigitMetalMaterial,
  createGlassBodyMaterial,
  createGlassReflectionMaterial,
  createGlowMaterial,
  createPlasmaMaterial,
  createRadialGlowTexture,
} from "./materials";

export type NixieTube = {
  group: THREE.Group;
  setDigit: (id: number) => void;
  getDigit: () => number;
  update: (timeSeconds: number) => void;
  /** The digit stack group — parent for effects that live in digit space. */
  emberAnchor: THREE.Group;
  /**
   * The emission surface for digit-burst effects: the halo tube (same stroke
   * curves as the sheath but ~2x the radius), so particles spawn in a
   * slightly thickened band around the glyph instead of exactly on the wire.
   */
  getEmberGeometry: (id: number) => THREE.BufferGeometry;
  /** The z offset of a digit inside the stack. */
  getDigitZ: (id: number) => number;
};

// Proportions derived from the reference photo, D = glass diameter = 1.9
const GLASS_R = 0.95;
const CUP_R = 1.03;
const CUP_H = 0.92;
const GLASS_BASE_Y = 0.35;

const CAGE_W = 1.44;
const CAGE_D = 0.94;
const CAGE_H = 2.0;
const CAGE_CORNER = 0.26;
const CAGE_BOTTOM_Y = 0.98;
const CAGE_CENTER_Y = CAGE_BOTTOM_Y + CAGE_H / 2;

const DIGIT_HEIGHT = 1.55;
const DIGIT_SPACING = 0.05;

export function createNixieTube(glowPalette?: NixieGlowPalette): NixieTube {
  const group = new THREE.Group();

  const base = new THREE.Mesh(
    createCopperCupGeometry(),
    createCopperMaterial(),
  );
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const glassGeo = createGlassEnvelopeGeometry();
  const glassBody = new THREE.Mesh(glassGeo, createGlassBodyMaterial());
  glassBody.position.y = GLASS_BASE_Y;
  glassBody.renderOrder = 10; // after the interior glow transparents
  const glassReflection = new THREE.Mesh(
    glassGeo,
    createGlassReflectionMaterial(),
  );
  glassReflection.position.y = GLASS_BASE_Y;
  glassReflection.renderOrder = 11;
  group.add(glassBody, glassReflection);

  group.add(createCage(glowPalette));

  const cores: THREE.Mesh[] = [];
  const sheaths: THREE.Mesh[] = [];
  const halos: THREE.Mesh[] = [];
  const offMaterial = createDigitMetalMaterial();
  const onMaterial = createPlasmaMaterial();
  const glowMaterial = createGlowMaterial();

  const stack = new THREE.Group();
  stack.position.y = CAGE_CENTER_Y - DIGIT_HEIGHT / 2;
  const stackDepth = 9 * DIGIT_SPACING;
  for (let id = 0; id <= 9; id++) {
    const geo = createDigitGeometry(id, DIGIT_HEIGHT);
    const z = stackDepth / 2 - id * DIGIT_SPACING;
    const core = new THREE.Mesh(geo.core, offMaterial);
    core.position.z = z;
    const sheath = new THREE.Mesh(geo.sheath, onMaterial);
    sheath.position.z = z;
    sheath.visible = false;
    const halo = new THREE.Mesh(geo.halo, glowMaterial);
    halo.position.z = z;
    halo.visible = false;
    cores.push(core);
    sheaths.push(sheath);
    halos.push(halo);
    stack.add(core, sheath, halo);
  }
  group.add(stack);

  // wide soft halo behind the lit digit — replaces post-process bloom
  const glowSprite = new THREE.Mesh(
    new THREE.PlaneGeometry(CAGE_W - 0.1, CAGE_H - 0.25),
    new THREE.MeshBasicMaterial({
      map: createRadialGlowTexture(),
      color: new THREE.Color(1.0, 0.105, 0.008),
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  glowSprite.position.set(0, DIGIT_HEIGHT * 0.48, 0);
  stack.add(glowSprite);

  // Every warm shade the tube carries, exposed to the one "Nixie Color"
  // picker: the emissive set (sheath/halo/sprite) AND the warm-tinted metals
  // (copper cup, unlit digit stack). At the reference color the palette
  // reproduces the authored values verbatim, so the default look is exact.
  glowPalette?.register(
    onMaterial.uniforms.edgeColor.value as THREE.Color,
    onMaterial.uniforms.coreColor.value as THREE.Color,
    onMaterial.uniforms.dimColor.value as THREE.Color,
    glowMaterial.uniforms.uColor.value as THREE.Color,
    (glowSprite.material as THREE.MeshBasicMaterial).color,
    (base.material as THREE.MeshPhysicalMaterial).color,
    offMaterial.color,
  );

  let current = 3;
  const applyDigit = (id: number) => {
    current = ((id % 10) + 10) % 10;
    for (let i = 0; i <= 9; i++) {
      const lit = i === current;
      sheaths[i].visible = lit;
      halos[i].visible = lit;
    }
    glowSprite.position.z = stackDepth / 2 - current * DIGIT_SPACING - 0.06;
  };
  applyDigit(current);

  return {
    group,
    setDigit: applyDigit,
    getDigit: () => current,
    // all glow variance is baked into the geometry for now; live plasma
    // shimmer/particles are a later pass
    update: () => {},
    emberAnchor: stack,
    getEmberGeometry: (id: number) =>
      halos[((id % 10) + 10) % 10].geometry as THREE.BufferGeometry,
    getDigitZ: (id: number) =>
      stackDepth / 2 - (((id % 10) + 10) % 10) * DIGIT_SPACING,
  };
}

function createCage(glowPalette?: NixieGlowPalette): THREE.Group {
  const cage = new THREE.Group();

  const wall = new THREE.Mesh(
    createCageWallGeometry({
      width: CAGE_W,
      depth: CAGE_D,
      height: CAGE_H,
      cornerRadius: CAGE_CORNER,
      cellSize: 0.09,
    }),
    createCageMaterial(),
  );
  wall.position.y = CAGE_CENTER_Y;
  cage.add(wall);

  const chrome = createChromeMaterial();
  // The gold-brown cage wires and warm-tinted chrome dominate what the glass
  // shows at grazing angles — they must follow the picker too.
  glowPalette?.register(
    (wall.material as THREE.MeshStandardMaterial).color,
    chrome.color,
  );
  const plateGeo = createCapPlateGeometry(
    CAGE_W + 0.04,
    CAGE_D + 0.04,
    CAGE_CORNER + 0.015,
    0.028,
  );
  const topPlate = new THREE.Mesh(plateGeo, chrome);
  topPlate.position.y = CAGE_BOTTOM_Y + CAGE_H;
  topPlate.rotation.z = 0.025;
  const bottomPlate = new THREE.Mesh(plateGeo, chrome);
  bottomPlate.position.y = CAGE_BOTTOM_Y - 0.03;
  cage.add(topPlate, bottomPlate);

  // thin support rods in the corners — disabled for now
  // const nickel = createNickelMaterial();
  // const rodGeo = new THREE.CylinderGeometry(0.007, 0.007, CAGE_H + 0.1, 8);
  // for (const [sx, sz] of [
  //   [1, 1],
  //   [-1, 1],
  //   [1, -1],
  //   [-1, -1],
  // ]) {
  //   const rod = new THREE.Mesh(rodGeo, nickel);
  //   rod.position.set(sx * (CAGE_W / 2 - CAGE_CORNER * 0.55), CAGE_CENTER_Y, sz * (CAGE_D / 2 - CAGE_CORNER * 0.55));
  //   cage.add(rod);
  // }

  return cage;
}

function createCopperCupGeometry(): THREE.LatheGeometry {
  const R = CUP_R;
  const inner = GLASS_R + 0.015;
  const h = CUP_H;
  const floor = 0.3;
  const pts = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(R - 0.02, 0.0),
    new THREE.Vector2(R, 0.025),
    new THREE.Vector2(R, h - 0.025),
    new THREE.Vector2(R - 0.02, h),
    new THREE.Vector2(inner, h),
    new THREE.Vector2(inner, floor),
    new THREE.Vector2(0.0, floor),
  ];
  return new THREE.LatheGeometry(pts, 96);
}

function createGlassEnvelopeGeometry(): THREE.LatheGeometry {
  const outer = glassProfile(GLASS_R, 0);
  const inner = glassProfile(GLASS_R, 0.05).reverse();
  return new THREE.LatheGeometry([...outer, ...inner], 96);
}

function glassProfile(radius: number, wall: number): THREE.Vector2[] {
  const r = (x: number) => Math.max(0.006, x - wall);
  const shrink = wall > 0 ? 0.03 : 0;
  const wallTop = 2.7;
  const domeH = 0.46;

  const pts: THREE.Vector2[] = [
    new THREE.Vector2(r(radius), 0.0 + shrink),
    new THREE.Vector2(r(radius), wallTop),
  ];
  // smooth dome: superellipse sweep from the wall to the nipple base
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    const a = ((i / steps) * Math.PI) / 2;
    const x = radius * Math.pow(Math.cos(a), 0.88);
    if (x <= radius * 0.105) {
      break;
    }
    pts.push(
      new THREE.Vector2(r(x), wallTop + domeH * Math.pow(Math.sin(a), 1.15)),
    );
  }
  // molded tip-off nipple
  const nippleBase = wallTop + domeH;
  for (const [x, dy] of [
    [radius * 0.105, -0.005],
    [radius * 0.072, 0.04],
    [radius * 0.13, 0.1],
    [radius * 0.105, 0.14],
    [radius * 0.048, 0.17],
    [radius * 0.015, 0.18],
  ]) {
    pts.push(new THREE.Vector2(r(x), nippleBase + dy));
  }
  return pts;
}
