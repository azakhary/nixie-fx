import type { ThreeGpuLightSource } from "./lights";
import {
  Box3,
  Euler,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  Sphere,
  Vector3,
  Vector4,
} from "three";
import {
  StorageInstancedBufferAttribute,
  UniformNode,
  type WebGPURenderer,
  type MeshBasicNodeMaterial,
  type MeshStandardNodeMaterial,
  type Node,
} from "three/webgpu";
import * as T from "three/tsl";
import type { ParticleEmitterDefinition } from "../../../engine/particles";
import {
  GPU_PARTICLE_CAPACITY,
  type ParticleComputeCapabilities,
} from "../../../engine/particleSimulation";
import type { ThreeVfxEffectInstanceOptions } from "../types";
import type { ThreeGpuEmitter } from "../renderAdapter";
import { createNodeMaterial } from "../node/adapter";
import { GpuCurveTable } from "./curves";

export function threeComputeCapabilities(
  renderer?: WebGPURenderer,
): ParticleComputeCapabilities {
  const backend = renderer?.backend as unknown as
    | {
        isWebGPUBackend?: boolean;
        device?: {
          limits: {
            maxStorageBufferBindingSize: number;
            maxBufferSize: number;
            maxStorageBuffersPerShaderStage: number;
            maxComputeInvocationsPerWorkgroup: number;
            maxComputeWorkgroupsPerDimension: number;
          };
        };
      }
    | undefined;
  const limits = backend?.device?.limits;
  const compute =
    backend?.isWebGPUBackend === true &&
    !!limits &&
    limits.maxStorageBuffersPerShaderStage >= 7 &&
    limits.maxComputeInvocationsPerWorkgroup >= 64;
  return {
    compute,
    maxParticles: compute
      ? Math.min(
          GPU_PARTICLE_CAPACITY,
          Math.floor(
            Math.min(
              limits!.maxStorageBufferBindingSize,
              limits!.maxBufferSize,
            ) / 16,
          ),
          limits!.maxComputeWorkgroupsPerDimension * 64,
        )
      : 0,
    reason: compute
      ? ""
      : "Native WebGPU compute with seven storage buffers and 64-lane workgroups is required.",
  };
}
const random = (id: Node<"uint">, salt: number) => {
  // Integer hash; random identity remains on GPU. No CPU population walk.
  const x = T.uint(id).add(T.uint(salt)).toVar();
  x.assign(x.bitXor(x.shiftRight(16)).mul(T.uint(0x7feb352d)));
  x.assign(x.bitXor(x.shiftRight(15)).mul(T.uint(0x846ca68b)));
  return T.float(x.bitXor(x.shiftRight(16))).div(4294967296);
};
/** Native bounded independent simulation. Two dispatches per logical update, zero readback. */
export class ThreeGpuParticleEmitter implements ThreeGpuEmitter {
  readonly root: Mesh;
  readonly capacity: number;
  readonly lightSource?: ThreeGpuLightSource;
  private readonly lightPasses: { dispose(): void }[] = [];
  private readonly table = new GpuCurveTable();
  private readonly dt = T.uniform(0);
  private readonly time = T.uniform(0);
  private readonly previous = T.uniform(-0.000001);
  private readonly seed = new UniformNode<"uint", number>(1, "uint");
  private readonly emitting = T.uniform(1);
  private readonly effectRate = T.uniform(1);
  private readonly effectVelocity = T.uniform(1);
  private readonly emitterRate = T.uniform(1);
  private readonly emitterVelocity = T.uniform(1);
  private readonly sizeMultiplier = T.uniform(1);
  private readonly tint = T.uniform(new Vector4(1, 1, 1, 1));
  private readonly transform = T.uniform(new Matrix4());
  private readonly resetPass;
  private readonly emissionPass;
  private readonly simulationPass;
  private readonly resolution;
  private running = true;
  private completedAt = Infinity;
  private lastTime = 0;
  private startedAt = 0;
  private maxLifetime: number;
  get active() {
    return this.running && this.lastTime < this.completedAt + this.maxLifetime;
  }
  /** Conservative occupied-slot upper bound, deliberately no synchronous GPU readback. */
  get estimatedCount() {
    return this.active && this.lastTime >= this.emitter.timeline.start
      ? this.capacity
      : 0;
  }
  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly emitter: ParticleEmitterDefinition,
    options: ThreeVfxEffectInstanceOptions,
  ) {
    this.capacity = emitter.maxParticles;
    const n = this.capacity;
    const geometry = new InstancedBufferGeometry();
    const plane = new PlaneGeometry(1, 1);
    geometry.index = plane.index;
    geometry.attributes = { ...plane.attributes };
    geometry.instanceCount = n;
    const buffer = (name: string, count = n) => {
      const attr = new StorageInstancedBufferAttribute(count, 4);
      geometry.setAttribute(name, attr);
      return T.storage(attr, "vec4", count);
    };
    const position = buffer("nfxPositionAge"),
      velocity = buffer("nfxVelocityLife"),
      initial = buffer("nfxInitial"),
      baseColor = buffer("nfxBaseColor"),
      color = buffer("nfxColor"),
      shape = buffer("nfxShape");
    const control = T.instancedArray(new Uint32Array(4), "uvec4");
    geometry.setAttribute("nfxControl", control.value);
    const init = emitter.initializeParticle;
    const scalar = this.table.scalar.bind(this.table);
    const rate = scalar(emitter.spawn.rateValue),
      life = scalar(init.lifetime),
      speed = scalar(init.velocity.speed),
      radius = scalar(emitter.spawn.radiusValue);
    const sizeX = scalar(
        init.startSizeSeparateAxes ? init.size3D.x : init.size,
      ),
      sizeY = scalar(init.startSizeSeparateAxes ? init.size3D.y : init.size);
    const sizeLifeX = scalar(emitter.billboard.sizeValue),
      sizeLifeY = scalar(
        emitter.billboard.separateAxes
          ? emitter.billboard.sizeValueY
          : emitter.billboard.sizeValue,
      );
    const rotation = scalar(init.rotation),
      spin = scalar(init.angularVelocity),
      gravity = scalar(emitter.forces.gravityValue),
      drag = scalar(emitter.forces.dragValue);
    const intensity = scalar(init.color.intensity),
      alpha = scalar(init.color.alpha),
      noise = scalar(emitter.advanced.noise.strength);
    const colorA = this.table.gradient(init.color.gradient),
      colorB = this.table.gradient(init.color.gradientB),
      overColor = this.table.gradient(emitter.color.gradient);
    const lighting = emitter.lightEmission;
    const lightColor = lighting
      ? this.table.gradient(lighting.color)
      : undefined;
    const lightIntensity = lighting ? scalar(lighting.intensity) : undefined;
    const lightRadius = lighting ? scalar(lighting.radius) : undefined;
    this.table.build();
    this.maxLifetime = Math.max(
      ...this.table.texture.image.data!.slice(256 * 4, 256 * 8),
    );
    this.maxLifetime = Math.max(0.02, this.maxLifetime);
    if (!emitter.loop)
      this.completedAt = emitter.timeline.start + emitter.duration;
    const duration = emitter.duration,
      start = emitter.timeline.start;
    const loopAge = this.time.sub(start).max(0).mod(duration).div(duration);
    this.resetPass = T.Fn(() => {
      const i = T.instanceIndex;
      position.element(i).assign(T.vec4(0, 0, 0, -1));
      velocity.element(i).assign(T.vec4(0));
      initial.element(i).assign(T.vec4(0));
      baseColor.element(i).assign(T.vec4(0));
      color.element(i).assign(T.vec4(0));
      shape.element(i).assign(T.vec4(0));
      T.If(i.equal(0), () => {
        control.element(0).assign(T.uvec4(0));
      });
    })().compute(n, [64]);
    this.emissionPass = T.Fn(() => {
      const c = control.element(0);
      const count = T.float(0).toVar();
      const age = this.time.sub(start);
      const prevAge = this.previous.sub(start);
      T.If(age.greaterThanEqual(0).and(this.emitting.greaterThan(0)), () => {
        const activeDt = this.time.sub(this.previous.max(start)).max(0);
        const rateDt = emitter.loop
          ? activeDt
          : this.time
              .min(start + duration)
              .sub(this.previous.max(start))
              .max(0);
        const fraction = T.float(
          T.bitcast(c.y, "float") as unknown as Node<"float">,
        )
          .add(
            rate(
              loopAge,
              random(
                this.seed.add(T.uint(age.max(0).div(duration).floor())),
                17,
              ),
            )
              .max(0)
              .mul(this.effectRate)
              .mul(this.emitterRate)
              .mul(rateDt),
          )
          .toVar();
        count.assign(fraction.floor());
        fraction.subAssign(count);
        c.y.assign(
          T.uint(T.bitcast(fraction, "uint") as unknown as Node<"uint">),
        );
        for (const burst of emitter.spawn.bursts) {
          for (let cycle = 0; cycle < burst.cycles; cycle++) {
            const at = burst.time + cycle * burst.interval;
            if (at > duration) continue;
            const currentCycle = age.sub(at).div(duration).floor();
            const previousCycle = prevAge.sub(at).div(duration).floor();
            const crossed = emitter.loop
              ? currentCycle.sub(previousCycle).max(0)
              : age.greaterThanEqual(at).and(prevAge.lessThan(at)).select(1, 0);
            const chance = random(
              T.uint(currentCycle.max(0)).add(this.seed),
              163 + cycle,
            ).lessThan(burst.probability);
            count.addAssign(chance.select(crossed.mul(burst.count), 0));
          }
        }
      });
      c.x.addAssign(T.uint(count));
      c.z.assign(c.z.add(T.uint(count)).mod(T.uint(n)));
      c.w.assign(T.uint(count.min(n)));
    })().compute(1);
    const spawnMatrix = new Matrix4().compose(
      new Vector3(...emitter.spawn.position),
      new Quaternion().setFromEuler(
        new Euler(
          ...(emitter.spawn.rotation.map((v) => (v * Math.PI) / 180) as [
            number,
            number,
            number,
          ]),
        ),
      ),
      new Vector3(...emitter.spawn.scale),
    );
    const spawnTransform = T.uniform(spawnMatrix);
    this.simulationPass = T.Fn(() => {
      const i = T.instanceIndex,
        p = position.element(i),
        v = velocity.element(i),
        a = initial.element(i),
        base = baseColor.element(i),
        c = control.element(0);
      const distance = c.z.add(T.uint(n)).sub(1).sub(i).mod(T.uint(n));
      const sequence = c.x.sub(1).sub(distance);
      const born = distance.lessThan(c.w);
      T.If(born, () => {
        const id = T.uint(sequence).add(this.seed);
        const r = random(id, 1),
          r2 = random(id, 2),
          r3 = random(id, 3);
        const theta = r.mul((emitter.spawn.arc * Math.PI) / 180);
        const z = emitter.spawn.shape === "hemisphere" ? r2 : r2.mul(2).sub(1);
        const radial = T.float(1).sub(z.mul(z)).max(0).sqrt();
        let direction: Node<"vec3"> = T.vec3(0, 1, 0);
        let pos: Node<"vec3"> = T.vec3(0);
        const rad = radius(loopAge, r3).mul(
          T.mix(
            T.float(1 - emitter.spawn.radiusThickness),
            T.float(1),
            r3.pow(
              ["sphere", "hemisphere"].includes(emitter.spawn.shape)
                ? 1 / 3
                : 1 / 2,
            ),
          ),
        );
        if (["sphere", "hemisphere"].includes(emitter.spawn.shape))
          direction = T.vec3(
            radial.mul(theta.cos()),
            z,
            radial.mul(theta.sin()),
          );
        if (["sphere", "hemisphere"].includes(emitter.spawn.shape))
          pos = direction.mul(rad);
        if (emitter.spawn.shape === "circle")
          pos = T.vec3(theta.cos().mul(rad), 0, theta.sin().mul(rad));
        if (emitter.spawn.shape === "box")
          pos = T.vec3(r, r2, r3)
            .sub(0.5)
            .mul(T.vec3(...emitter.spawn.box));
        if (emitter.spawn.shape === "cone") {
          direction = T.vec3(
            theta.cos().mul(Math.sin((emitter.spawn.angle * Math.PI) / 180)),
            Math.cos((emitter.spawn.angle * Math.PI) / 180),
            theta.sin().mul(Math.sin((emitter.spawn.angle * Math.PI) / 180)),
          );
          pos = T.vec3(theta.cos().mul(rad), 0, theta.sin().mul(rad));
        }
        if (emitter.spawn.shape === "point" || emitter.spawn.shape === "box")
          direction = T.vec3(0, 1, 0);
        pos = pos.add(
          T.vec3(random(id, 4), random(id, 5), random(id, 6))
            .sub(0.5)
            .mul(emitter.spawn.randomPositionAmount * 2),
        );
        const randomDirection = T.vec3(
          random(id, 7),
          random(id, 8),
          random(id, 9),
        )
          .mul(2)
          .sub(1)
          .normalize();
        direction = T.mix(
          direction,
          randomDirection,
          emitter.spawn.randomDirectionAmount,
        ).normalize();
        direction = T.mix(
          direction,
          pos.div(pos.length().max(0.00001)),
          emitter.spawn.sphericalDirectionAmount,
        ).normalize();
        const matrix =
          emitter.spawn.simulationSpace === "world"
            ? this.transform.mul(spawnTransform)
            : spawnTransform;
        p.xyz.assign(matrix.mul(T.vec4(pos, 1)).xyz);
        p.w.assign(0);
        const initialVelocity =
          init.velocity.mode === "vector"
            ? T.vec3(...init.velocity.min).add(
                T.vec3(...init.velocity.max)
                  .sub(T.vec3(...init.velocity.min))
                  .mul(T.vec3(r, r2, r3)),
              )
            : direction.mul(speed(loopAge, r));
        v.xyz.assign(
          matrix.mul(
            T.vec4(
              initialVelocity
                .mul(this.effectVelocity)
                .mul(this.emitterVelocity),
              0,
            ),
          ).xyz,
        );
        v.w.assign(life(loopAge, r2).max(0.02));
        a.assign(
          T.vec4(
            sizeX(loopAge, r),
            sizeY(loopAge, init.startSizeSeparateAxes ? r2 : r),
            rotation(loopAge, r3),
            r,
          ),
        );
        let rgb: Node<"vec4"> = T.vec4(...init.color.color);
        if (init.color.mode === "random")
          rgb = T.mix(rgb, T.vec4(...init.color.colorB), r);
        if (init.color.mode === "gradient") rgb = colorA(r);
        if (init.color.mode === "randomGradient")
          rgb = T.mix(colorA(r), colorB(r), r);
        base.assign(
          T.vec4(
            rgb.rgb.mul(intensity(loopAge, r)),
            (init.color.mode === "constant" || init.color.mode === "random"
              ? T.float(1)
              : rgb.a
            ).mul(alpha(loopAge, r)),
          ),
        );
      });
      T.If(p.w.greaterThanEqual(0).and(p.w.lessThan(v.w)), () => {
        const age = p.w.div(v.w).clamp();
        const dt = born.select(0, this.dt);
        if (emitter.modules.velocity) {
          v.y.subAssign(gravity(age, a.w, loopAge).mul(dt));
          v.xyz.mulAssign(drag(age, a.w, loopAge).mul(dt).negate().exp());
        }
        p.xyz.addAssign(v.xyz.mul(dt));
        if (emitter.modules.noise) {
          const settings = emitter.advanced.noise;
          const field = T.vec3(0).toVar();
          for (let octave = 0; octave < settings.octaves; octave++) {
            const phase = p.xyz
              .mul(settings.frequency * 2 ** octave)
              .add(T.vec3(...settings.scroll).mul(this.time))
              .add(this.time.mul(settings.speed))
              .add(a.w.mul(6.283185));
            field.addAssign(
              T.vec3(
                phase.x.sin(),
                phase.y.add(2.094).sin(),
                phase.z.add(4.189).sin(),
              ).mul(0.5 ** octave),
            );
          }
          p.xyz.addAssign(
            field
              .mul(noise(age, a.w, loopAge))
              .mul(T.float(1).sub(age.mul(settings.damping)))
              .mul(dt),
          );
        }
        p.w.addAssign(dt);
        if (emitter.modules.rotation)
          a.z.addAssign(spin(age, a.w, loopAge).mul(dt));
        const col = emitter.modules.color ? base.mul(overColor(age)) : base;
        color.element(i).assign(col.mul(this.tint));
        const sx = emitter.modules.size
          ? sizeLifeX(age, a.w, loopAge)
          : T.float(1);
        const sy = emitter.modules.size
          ? sizeLifeY(age, a.w, loopAge)
          : T.float(1);
        shape
          .element(i)
          .assign(
            T.vec4(
              a.x.mul(sx).mul(this.sizeMultiplier),
              a.y.mul(sy).mul(this.sizeMultiplier),
              a.z,
              1,
            ),
          );
      }).Else(() => {
        color.element(i).assign(T.vec4(0));
        shape.element(i).assign(T.vec4(0));
      });
    })().compute(n, [64]);
    const particleColor = T.attribute<"vec4">("nfxColor", "vec4");
    this.resolution = createNodeMaterial(
      emitter,
      options,
      false,
      particleColor,
    );
    const material = this.resolution.material as
      MeshBasicNodeMaterial | MeshStandardNodeMaterial;
    const p = T.attribute<"vec4">("nfxPositionAge", "vec4"),
      s = T.attribute<"vec4">("nfxShape", "vec4");
    const local = T.positionGeometry.xy
      .sub(T.vec2(...emitter.billboard.pivot))
      .mul(s.xy);
    const xy = T.vec2(
      local.x.mul(s.z.cos()).sub(local.y.mul(s.z.sin())),
      local.x.mul(s.z.sin()).add(local.y.mul(s.z.cos())),
    );
    const center =
      emitter.spawn.simulationSpace === "world"
        ? p.xyz
        : T.modelWorldMatrix.mul(T.vec4(p.xyz, 1)).xyz;
    const world = center.add(T.cameraWorldMatrix.mul(T.vec4(xy, 0, 0)).xyz);
    material.positionNode = T.modelWorldMatrixInverse.mul(T.vec4(world, 1)).xyz;
    const oldOpacity = material.opacityNode ?? T.float(1);
    material.opacityNode = T.Fn(() => {
      T.Discard(s.w.lessThan(0.5));
      return oldOpacity;
    })();
    this.root = new Mesh(geometry, material);
    this.root.name = `GPU ${emitter.id}`;
    const bounds = emitter.simulation!.bounds;
    geometry.boundingBox = new Box3(
      new Vector3(...bounds.min),
      new Vector3(...bounds.max),
    );
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
      new Sphere(),
    );
    // World-space populations do not follow subsequent host motion; test their
    // authored world bounds explicitly instead of transforming a local sphere.
    this.root.frustumCulled = true;
    this.root.raycast = () => {}; // no CPU mirror, selection belongs to emitter gizmos
    this.root.renderOrder = emitter.render.orderInLayer;
    if (
      lighting &&
      lighting.enabled !== false &&
      lighting.mode !== "disabled" &&
      lighting.maxLights !== 0
    ) {
      const offset = T.uniform(0),
        count = T.uniform(0),
        view = T.uniform(new Matrix4()),
        worldMatrix = T.uniform(new Matrix4());
      let output: import("three/webgpu").StorageBufferNode<"vec4"> | undefined;
      let pass: import("three/webgpu").ComputeNode | undefined;
      this.lightSource = {
        requestedLights:
          lighting.mode === "emitter"
            ? 1
            : Math.min(512, lighting.maxLights ?? 512, n),
        writeLights: (target, start, amount, camera) => {
          if (target !== output) {
            pass?.dispose();
            output = target;
            pass = T.Fn(() => {
              const lane = T.instanceIndex;
              T.If(T.float(lane).lessThan(count), () => {
                const out = T.uint(offset).add(lane).mul(2);
                target.element(out).assign(T.vec4(0));
                target.element(out.add(1)).assign(T.vec4(0));
                const selected = T.int(-1).toVar();
                if (lighting.mode === "emitter") {
                  T.If(
                    this.time
                      .greaterThanEqual(start)
                      .and(
                        emitter.loop
                          ? T.bool(true)
                          : this.time.lessThanEqual(start + duration),
                      )
                      .and(this.emitting.greaterThan(0)),
                    () => {
                      selected.assign(0);
                    },
                  );
                } else {
                  // Partition scan: total work O(capacity), bounded output. Each
                  // lane retains its lowest live slot until it dies/recycles.
                  T.Loop(
                    {
                      start: T.int(lane),
                      end: n,
                      condition: "<",
                      update: T.int(count),
                    },
                    ({ i }) => {
                      const p = position.element(i),
                        v = velocity.element(i);
                      T.If(
                        p.w.greaterThanEqual(0).and(p.w.lessThan(v.w)),
                        () => {
                          selected.assign(i);
                          T.Break();
                        },
                      );
                    },
                  );
                }
                T.If(selected.greaterThanEqual(0), () => {
                  const p = position.element(selected),
                    v = velocity.element(selected),
                    meta = initial.element(selected);
                  const age =
                    lighting.mode === "emitter"
                      ? loopAge
                      : p.w.div(v.w).clamp();
                  const random =
                    lighting.mode === "emitter" ? T.float(0.5) : meta.w;
                  const lc =
                    lighting.useParticleColor && lighting.mode === "particles"
                      ? color.element(selected)
                      : lightColor!(age);
                  const intensity = lightIntensity!(age, random, loopAge)
                    .mul(lc.a)
                    .max(0);
                  const radius = lightRadius!(age, random, loopAge).max(0);
                  const local =
                    lighting.mode === "emitter"
                      ? T.vec3(...emitter.spawn.position)
                      : p.xyz;
                  const world =
                    emitter.spawn.simulationSpace === "world" &&
                    lighting.mode !== "emitter"
                      ? local
                      : worldMatrix.mul(T.vec4(local, 1)).xyz;
                  target
                    .element(out)
                    .assign(T.vec4(view.mul(T.vec4(world, 1)).xyz, radius));
                  target
                    .element(out.add(1))
                    .assign(T.vec4(lc.rgb.mul(intensity), 2));
                });
              });
            })().compute(512, [64]);
            this.lightPasses.push(pass);
          }
          offset.value = start;
          count.value = amount;
          view.value.copy(camera.matrixWorldInverse);
          this.root.updateWorldMatrix(true, false);
          worldMatrix.value.copy(this.root.matrixWorld);
          this.renderer.compute(pass!);
        },
      };
    }
    this.setRuntimeParameters(options.runtimeParameters ?? {});
    this.reset(options.seed ?? 1, options.timeSeconds ?? 0);
  }
  reset(seed: number, startedAt = 0) {
    this.startedAt = startedAt;
    this.seed.value = seed >>> 0;
    this.running = true;
    this.emitting.value = 1;
    this.previous.value = -0.000001;
    this.lastTime = 0;
    this.time.value = 0;
    this.completedAt = this.emitter.loop
      ? Infinity
      : this.emitter.timeline.start + this.emitter.duration;
    this.renderer.compute(this.resetPass);
  }
  update(dt: number, time: number, transform: Matrix4) {
    if (!this.running) return;
    const elapsed = Math.max(0, time - this.startedAt);
    this.dt.value = dt;
    this.time.value = elapsed;
    this.transform.value.copy(transform);
    if (this.emitter.spawn.simulationSpace === "world") {
      const b = this.emitter.simulation!.bounds;
      this.root.geometry.boundingBox!.set(
        new Vector3(...b.min),
        new Vector3(...b.max),
      );
      this.root.geometry.boundingBox!.getBoundingSphere(
        this.root.geometry.boundingSphere!,
      );
      this.root.geometry.boundingSphere!.applyMatrix4(
        new Matrix4().copy(transform).invert(),
      );
    }
    this.renderer.compute(this.emissionPass);
    this.renderer.compute(this.simulationPass);
    this.previous.value = elapsed;
    this.lastTime = elapsed;
    this.resolution.updateTime?.(time);
  }
  setRuntimeParameters(
    parameters: import("../types").ThreeVfxEmitterRuntimeParameterPatch,
    emitterScoped = false,
  ) {
    if (parameters.sizeMultiplierValue || parameters.colorOverLifetimeGradient)
      throw new Error(
        "GPU independent-v1 does not support runtime curve/gradient overrides; edit the definition and reset.",
      );
    const finite = (value: number) =>
      Number.isFinite(value) ? Math.max(0, value) : 1;
    if (parameters.emissionRateMultiplier !== undefined)
      (emitterScoped ? this.emitterRate : this.effectRate).value = finite(
        parameters.emissionRateMultiplier,
      );
    if (parameters.initialVelocityMultiplier !== undefined)
      (emitterScoped ? this.emitterVelocity : this.effectVelocity).value =
        finite(parameters.initialVelocityMultiplier);
    if (parameters.sizeMultiplier !== undefined)
      this.sizeMultiplier.value = finite(parameters.sizeMultiplier);
    if (parameters.colorTint)
      this.tint.value.fromArray(parameters.colorTint.map(finite));
  }
  resumeEmission() {
    this.emitting.value = 1;
    this.completedAt = this.emitter.loop
      ? Infinity
      : this.emitter.timeline.start + this.emitter.duration;
  }
  allowCompletion() {
    this.emitting.value = 0;
    this.completedAt = this.lastTime;
  }
  dispose() {
    this.running = false;
    this.root.removeFromParent();
    this.resetPass.dispose();
    this.emissionPass.dispose();
    this.simulationPass.dispose();
    this.root.geometry.dispose();
    // Compute-only buffers may never have been registered with the render
    // geometry manager (e.g. stop before the first render). Release those too.
    const backend = this.renderer.backend as unknown as {
      get(attribute: unknown): { buffer?: unknown };
      destroyAttribute(attribute: unknown): void;
    };
    for (const attribute of Object.values(this.root.geometry.attributes)) {
      if (
        attribute instanceof StorageInstancedBufferAttribute &&
        backend.get(attribute).buffer
      )
        backend.destroyAttribute(attribute);
    }
    this.resolution.material.dispose();
    this.table.dispose();
    for (const pass of this.lightPasses) pass.dispose();
  }
}
