import { beforeEach, describe, expect, it, vi } from "vitest";

const { textureFrom, imageSourceTest, canvasSourceTest } = vi.hoisted(() => ({
  textureFrom: vi.fn((canvas: unknown) => ({ canvas })),
  imageSourceTest: vi.fn(() => true),
  canvasSourceTest: vi.fn(() => false),
}));

vi.mock("pixi.js", () => {
  class Texture {
    source: unknown;
    frame: unknown;
    constructor(options: { source?: unknown; frame?: unknown } = {}) {
      this.source = options.source;
      this.frame = options.frame;
    }
    static from = textureFrom;
  }
  class ImageSource {
    resource: unknown;
    alphaMode: unknown;
    constructor(options: { resource?: unknown; alphaMode?: unknown } = {}) {
      this.resource = options.resource;
      this.alphaMode = options.alphaMode;
    }
    static test = imageSourceTest;
  }
  class CanvasSource {
    resource: unknown;
    alphaMode: unknown;
    constructor(options: { resource?: unknown; alphaMode?: unknown } = {}) {
      this.resource = options.resource;
      this.alphaMode = options.alphaMode;
    }
    static test = canvasSourceTest;
  }
  return { Texture, ImageSource, CanvasSource };
});

const { createDerivedAlphaTexture, createPremultipliedSourceTexture } =
  await import("./material");

describe("Pixi material helpers", () => {
  beforeEach(() => {
    textureFrom.mockClear();
    imageSourceTest.mockReset();
    imageSourceTest.mockReturnValue(true);
    canvasSourceTest.mockReset();
    canvasSourceTest.mockReturnValue(false);
  });

  it("derives alpha from the texture frame instead of the full source image", () => {
    const drawImage = vi.fn();
    const putImageData = vi.fn();
    const context = {
      drawImage,
      getImageData: vi.fn(() => ({
        data: Uint8ClampedArray.from([40, 80, 120, 255]),
      })),
      putImageData,
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
    };
    const documentRef = {
      createElement: vi.fn(() => canvas),
    };
    const image = {} as CanvasImageSource;
    const texture = {
      source: {
        resource: image,
        pixelWidth: 128,
        pixelHeight: 64,
      },
      frame: {
        x: 16,
        y: 8,
        width: 32,
        height: 24,
      },
    };

    const derived = createDerivedAlphaTexture(
      texture as never,
      "red",
      false,
      documentRef as never,
    );

    expect(canvas.width).toBe(32);
    expect(canvas.height).toBe(24);
    expect(drawImage).toHaveBeenCalledWith(image, 16, 8, 32, 24, 0, 0, 32, 24);
    expect(putImageData).toHaveBeenCalledWith(
      expect.objectContaining({
        data: Uint8ClampedArray.from([40, 80, 120, 40]),
      }),
      0,
      0,
    );
    expect(derived).toEqual({ canvas });
  });

  it("tags an image-like source as premultiplied-alpha over the same pixels (I13-A)", () => {
    const resource = {} as CanvasImageSource;
    const frame = { x: 0, y: 0, width: 8, height: 8 };
    const source = { source: { resource }, frame };

    const premultiplied = createPremultipliedSourceTexture(source as never);

    expect(premultiplied).not.toBe(source);
    const tagged = premultiplied as unknown as {
      source: { resource: unknown; alphaMode: unknown };
      frame: unknown;
    };
    expect(tagged.source.resource).toBe(resource);
    expect(tagged.source.alphaMode).toBe("premultiplied-alpha");
    expect(tagged.frame).toBe(frame);
  });

  it("tags a canvas-backed derived source as premultiplied-alpha via CanvasSource (I13-A)", () => {
    // A derived opacity-source texture (createDerivedAlphaTexture ->
    // Texture.from(canvas)) is canvas-backed: ImageSource.test misses it, but
    // CanvasSource.test matches. The premultiplied tag must still apply, or Pixi
    // silently diverges from Three for every non-textureAlpha opacity source.
    imageSourceTest.mockReturnValue(false);
    canvasSourceTest.mockReturnValue(true);
    const resource = {} as CanvasImageSource;
    const frame = { x: 0, y: 0, width: 8, height: 8 };
    const source = { source: { resource }, frame };

    const premultiplied = createPremultipliedSourceTexture(source as never);

    expect(premultiplied).not.toBe(source);
    const tagged = premultiplied as unknown as {
      source: { resource: unknown; alphaMode: unknown };
      frame: unknown;
    };
    expect(tagged.source.resource).toBe(resource);
    expect(tagged.source.alphaMode).toBe("premultiplied-alpha");
    expect(tagged.frame).toBe(frame);
  });

  it("returns the source unchanged when the resource is unreadable (I13-A)", () => {
    // No resource (headless / Texture.EMPTY): never constructs a new source.
    const noResource = { source: { resource: undefined }, frame: {} };
    expect(createPremultipliedSourceTexture(noResource as never)).toBe(
      noResource,
    );
    expect(imageSourceTest).not.toHaveBeenCalled();

    // A resource matching neither ImageSource nor CanvasSource falls back.
    imageSourceTest.mockReturnValue(false);
    canvasSourceTest.mockReturnValue(false);
    const nonImage = { source: { resource: {} }, frame: {} };
    expect(createPremultipliedSourceTexture(nonImage as never)).toBe(nonImage);
  });
});
