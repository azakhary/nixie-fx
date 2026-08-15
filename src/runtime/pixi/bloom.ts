import {
  BlurFilter,
  Container,
  Rectangle,
  RenderTexture,
  Sprite,
  Texture,
} from "pixi.js";
import type {
  PixiVfxBloomOptions,
  PixiVfxBloomQuality,
  PixiVfxRenderTargetRenderer,
  PixiVfxRendererStats,
} from "./types";

export interface ResolvedBloomConfig {
  enabled: boolean;
  quality: Exclude<PixiVfxBloomQuality, "off">;
  renderScale: number;
  threshold: number;
  intensity: number;
  radius: number;
  softKnee: number;
  exposure: number;
}

export interface BloomDrawSettings {
  enabled: boolean;
  threshold: number;
  intensity: number;
  radius: number;
  softKnee: number;
  exposure: number;
}

const BALANCED_BLOOM_RENDER_SCALE = 0.25;
const BALANCED_BLOOM_THRESHOLD = 1;
const BALANCED_BLOOM_INTENSITY = 4;
const BALANCED_BLOOM_RADIUS = 26;
const BALANCED_BLOOM_SOFT_KNEE = 0.5;
const BLOOM_PYRAMID_MIN_RENDER_SCALE = 0.03125;
const BLOOM_PYRAMID_LOW_MAX_LEVELS = 4;
const BLOOM_PYRAMID_HIGH_MAX_LEVELS = 5;

export const DEFAULT_BLOOM_CONFIG: ResolvedBloomConfig = {
  enabled: false,
  quality: "low",
  renderScale: BALANCED_BLOOM_RENDER_SCALE,
  threshold: BALANCED_BLOOM_THRESHOLD,
  intensity: BALANCED_BLOOM_INTENSITY,
  radius: BALANCED_BLOOM_RADIUS,
  softKnee: BALANCED_BLOOM_SOFT_KNEE,
  exposure: 0,
};

export const DISABLED_BLOOM_DRAW_SETTINGS: BloomDrawSettings = {
  enabled: false,
  threshold: BALANCED_BLOOM_THRESHOLD,
  intensity: 0,
  radius: 0,
  softKnee: BALANCED_BLOOM_SOFT_KNEE,
  exposure: 0,
};

export function normalizeBloomConfig(
  value: PixiVfxBloomOptions | undefined,
): ResolvedBloomConfig {
  const quality =
    value?.quality === "high" || value?.quality === "off"
      ? value.quality
      : "low";
  const enabled = Boolean(value?.enabled) && quality !== "off";
  const defaultScale =
    quality === "high" ? 0.5 : DEFAULT_BLOOM_CONFIG.renderScale;
  const defaultRadius = quality === "high" ? 12 : DEFAULT_BLOOM_CONFIG.radius;
  return {
    enabled,
    quality: quality === "high" ? "high" : "low",
    renderScale: clamp(finiteOr(value?.renderScale, defaultScale), 0.125, 1),
    threshold: Math.max(
      0,
      finiteOr(value?.threshold, DEFAULT_BLOOM_CONFIG.threshold),
    ),
    intensity: clamp(
      finiteOr(value?.intensity, DEFAULT_BLOOM_CONFIG.intensity),
      0,
      4,
    ),
    radius: clamp(finiteOr(value?.radius, defaultRadius), 0, 64),
    softKnee: clamp(
      finiteOr(value?.softKnee, DEFAULT_BLOOM_CONFIG.softKnee),
      0,
      1,
    ),
    exposure: clamp(
      finiteOr(value?.exposure, DEFAULT_BLOOM_CONFIG.exposure),
      -2,
      2,
    ),
  };
}

export function bloomDrawSettings(
  config: ResolvedBloomConfig,
): BloomDrawSettings {
  return config.enabled && config.intensity > 0
    ? {
        enabled: true,
        threshold: config.threshold,
        intensity: config.intensity,
        radius: config.radius,
        softKnee: config.softKnee,
        exposure: config.exposure,
      }
    : DISABLED_BLOOM_DRAW_SETTINGS;
}

export class BloomComposer {
  readonly outputSprite = new Container();

  private sourceTexture?: RenderTexture;
  private outputTexture?: RenderTexture;
  private readonly compositeRoot = new Container();
  private readonly outputLayers: Sprite[] = [];
  private readonly levels: BloomPyramidLevel[] = [];
  private width = 0;
  private height = 0;
  private renderScale = 0;
  private quality: ResolvedBloomConfig["quality"] =
    DEFAULT_BLOOM_CONFIG.quality;
  private levelCount = 0;
  private passCount = 0;

  constructor(private readonly renderer: PixiVfxRenderTargetRenderer) {
    this.outputSprite.visible = false;
  }

  render(
    sourceRoot: Container,
    sourceParticles: number,
    config: ResolvedBloomConfig,
  ): PixiVfxRendererStats["bloomPasses"] {
    if (!config.enabled || config.intensity <= 0 || sourceParticles <= 0) {
      this.outputSprite.visible = false;
      return 0;
    }
    const screen = this.renderer.screen;
    const width = Math.max(1, Math.ceil(screen.width));
    const height = Math.max(1, Math.ceil(screen.height));
    if (width <= 1 || height <= 1) {
      this.outputSprite.visible = false;
      return 0;
    }
    this.ensureTextures(width, height, config);
    if (!this.sourceTexture || !this.outputTexture) {
      this.outputSprite.visible = false;
      return 0;
    }

    this.renderer.render({
      container: sourceRoot,
      target: this.sourceTexture,
      clear: true,
      clearColor: 0x00000000,
    });
    let previousTexture: Texture = this.sourceTexture;
    for (let i = 0; i < this.levels.length; i++) {
      const level = this.levels[i]!;
      level.sourceSprite.texture = previousTexture;
      level.sourceSprite.width = width;
      level.sourceSprite.height = height;
      level.compositeSprite.alpha = bloomPyramidWeight(i, config.radius);
      this.applyLevelFilterConfig(level, config, i);
      this.renderer.render({
        container: level.blurRoot,
        target: level.outputTexture,
        clear: true,
        clearColor: 0x00000000,
      });
      previousTexture = level.outputTexture;
    }

    this.renderer.render({
      container: this.compositeRoot,
      target: this.outputTexture,
      clear: true,
      clearColor: 0x00000000,
    });

    this.configureOutputLayers(
      this.outputTexture,
      config.intensity,
      width,
      height,
    );
    this.outputSprite.visible = true;
    return this.passCount;
  }

  destroy(): void {
    this.destroyLevels();
    this.compositeRoot.destroy({ children: false });
    this.outputSprite.destroy({ children: true });
    this.sourceTexture?.destroy(true);
    this.outputTexture?.destroy(true);
    this.sourceTexture = undefined;
    this.outputTexture = undefined;
  }

  private configureOutputLayers(
    texture: Texture,
    intensity: number,
    width: number,
    height: number,
  ): void {
    let remaining = Math.max(0, intensity);
    const layerCount = Math.max(1, Math.ceil(remaining));
    while (this.outputLayers.length < layerCount) {
      const layer = new Sprite(Texture.EMPTY);
      layer.blendMode = "add";
      this.outputLayers.push(layer);
      this.outputSprite.addChild(layer);
    }
    for (let i = 0; i < this.outputLayers.length; i++) {
      const layer = this.outputLayers[i]!;
      const alpha = Math.min(1, remaining);
      layer.texture = texture;
      layer.alpha = alpha;
      layer.width = width;
      layer.height = height;
      layer.visible = alpha > 0;
      remaining -= alpha;
    }
  }

  private ensureTextures(
    width: number,
    height: number,
    config: ResolvedBloomConfig,
  ): void {
    const scale = config.renderScale;
    const levelCount = bloomPyramidLevelCount(config);
    if (
      this.sourceTexture &&
      this.outputTexture &&
      this.width === width &&
      this.height === height &&
      this.renderScale === scale &&
      this.quality === config.quality &&
      this.levelCount === levelCount
    ) {
      this.applyFilterConfig(config);
      return;
    }
    this.sourceTexture?.destroy(true);
    this.outputTexture?.destroy(true);
    this.destroyLevels();
    this.width = width;
    this.height = height;
    this.renderScale = scale;
    this.quality = config.quality;
    this.levelCount = levelCount;
    this.sourceTexture = RenderTexture.create({
      width,
      height,
      resolution: scale,
    });
    this.outputTexture = RenderTexture.create({
      width,
      height,
      resolution: 1,
    });
    for (let i = 0; i < levelCount; i++) {
      const level = createBloomPyramidLevel(width, height, scale, i);
      this.levels.push(level);
      this.compositeRoot.addChild(level.compositeSprite);
    }
    this.applyFilterConfig(config);
  }

  private applyFilterConfig(config: ResolvedBloomConfig): void {
    let estimatedFilterPasses = 0;
    for (let i = 0; i < this.levels.length; i++) {
      estimatedFilterPasses += this.applyLevelFilterConfig(
        this.levels[i]!,
        config,
        i,
      );
    }
    this.passCount = 2 + this.levels.length + estimatedFilterPasses;
  }

  private applyLevelFilterConfig(
    level: BloomPyramidLevel,
    config: ResolvedBloomConfig,
    index: number,
  ): number {
    const blurFilter = this.ensureLevelBlurFilter(level);
    if (!blurFilter) {
      level.sourceSprite.filters = null;
      return 0;
    }
    const levelSpread = 0.55 + index * 0.35;
    blurFilter.strength = Math.max(0.5, config.radius * levelSpread);
    blurFilter.quality = config.quality === "high" ? 4 : 2;
    blurFilter.resolution = level.scale;
    level.filterList ??= [blurFilter];
    level.sourceSprite.filters = level.filterList;
    return blurFilter.quality * 2;
  }

  private ensureLevelBlurFilter(
    level: BloomPyramidLevel,
  ): BlurFilter | undefined {
    if (level.blurFilter) return level.blurFilter;
    if (level.blurFilterUnsupported) return undefined;
    try {
      level.blurFilter = new BlurFilter({
        strength: DEFAULT_BLOOM_CONFIG.radius,
        quality: 2,
        kernelSize: 5,
      });
      return level.blurFilter;
    } catch {
      level.blurFilterUnsupported = true;
      return undefined;
    }
  }

  private destroyLevels(): void {
    for (const level of this.levels) {
      level.sourceSprite.filters = null;
      level.blurFilter?.destroy();
      level.blurRoot.destroy({ children: false });
      level.compositeSprite.destroy();
      level.outputTexture.destroy(true);
    }
    this.levels.length = 0;
    this.compositeRoot.removeChildren();
  }
}

interface BloomPyramidLevel {
  sourceSprite: Sprite;
  blurRoot: Container;
  compositeSprite: Sprite;
  outputTexture: RenderTexture;
  filterArea: Rectangle;
  scale: number;
  blurFilter?: BlurFilter;
  filterList?: [BlurFilter];
  blurFilterUnsupported: boolean;
}

function createBloomPyramidLevel(
  width: number,
  height: number,
  baseScale: number,
  index: number,
): BloomPyramidLevel {
  const scale = Math.max(
    BLOOM_PYRAMID_MIN_RENDER_SCALE,
    baseScale / 2 ** index,
  );
  const outputTexture = RenderTexture.create({
    width,
    height,
    resolution: scale,
  });
  const sourceSprite = new Sprite(Texture.EMPTY);
  const blurRoot = new Container();
  const filterArea = new Rectangle(0, 0, width, height);
  sourceSprite.x = 0;
  sourceSprite.y = 0;
  sourceSprite.width = width;
  sourceSprite.height = height;
  blurRoot.filterArea = filterArea;
  blurRoot.addChild(sourceSprite);

  const compositeSprite = new Sprite(outputTexture);
  compositeSprite.blendMode = "add";
  compositeSprite.width = width;
  compositeSprite.height = height;

  return {
    sourceSprite,
    blurRoot,
    compositeSprite,
    outputTexture,
    filterArea,
    scale,
    blurFilterUnsupported: false,
  };
}

function bloomPyramidLevelCount(config: ResolvedBloomConfig): number {
  if (config.radius <= 0) return 1;
  const maxLevels =
    config.quality === "high"
      ? BLOOM_PYRAMID_HIGH_MAX_LEVELS
      : BLOOM_PYRAMID_LOW_MAX_LEVELS;
  const radiusDriven = Math.ceil(2 + config.radius / 8);
  return Math.max(2, Math.min(maxLevels, radiusDriven));
}

function bloomPyramidWeight(index: number, radius: number): number {
  const scatter = clamp(radius / 16, 0.18, 0.95);
  return index === 0 ? 0.45 : Math.pow(scatter, index * 0.42);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
