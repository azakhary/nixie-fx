import { DataTexture, FloatType, RGBAFormat } from "three";
import type { Node } from "three/webgpu";
import * as T from "three/tsl";
import {
  sampleParticleScalarValue,
  sampleParticleGradientColor,
  sampleParticleGradientAlpha,
  type ParticleScalarValue,
  type ParticleColorGradientSettings,
} from "../../../engine/particles";

/** 256-point authoring LUTs, uploaded only on definition changes. */
export class GpuCurveTable {
  private readonly rows: number[][] = [];
  texture!: DataTexture;
  scalar(value: ParticleScalarValue) {
    const row = this.rows.length;
    this.rows.push(
      Array.from({ length: 256 }, (_, i) => [
        sampleParticleScalarValue(value, i / 255, 0, i / 255),
        sampleParticleScalarValue(value, i / 255, 1, i / 255),
        0,
        0,
      ]).flat(),
    );
    return (
      age: Node<"float">,
      random: Node<"float">,
      loopAge: Node<"float"> = age,
    ) => {
      const v = this.sample(row, value.xAxis === "loopAge" ? loopAge : age);
      return T.mix(v.x, v.y, random);
    };
  }
  gradient(value: ParticleColorGradientSettings) {
    const row = this.rows.length;
    this.rows.push(
      Array.from({ length: 256 }, (_, i) => [
        ...sampleParticleGradientColor(value, i / 255),
        sampleParticleGradientAlpha(value, i / 255),
      ]).flat(),
    );
    return (age: Node<"float">) => this.sample(row, age);
  }
  build() {
    this.texture = new DataTexture(
      new Float32Array(this.rows.flat()),
      256,
      this.rows.length,
      RGBAFormat,
      FloatType,
    );
    this.texture.needsUpdate = true;
  }
  private sample(row: number, age: Node<"float">) {
    const x = age.clamp().mul(255);
    const a = T.textureLoad(this.texture, T.ivec2(T.int(x.floor()), row));
    const b = T.textureLoad(this.texture, T.ivec2(T.int(x.ceil()), row));
    return T.mix(a, b, x.fract());
  }
  dispose() {
    this.texture.dispose();
  }
}
