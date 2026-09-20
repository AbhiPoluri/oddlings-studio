/**
 * Minimal DOM shims so three.js exporters run under Node.
 *
 * `GLTFExporter` reads blobs through `FileReader`, which Node does not expose
 * as a global. Everything else it needs (`Blob`, `TextEncoder`, `btoa`) is
 * already built in from Node 18 onwards. Import this module once, before the
 * exporters, from any headless entry point (CLI, MCP server, tests). It is a
 * no-op in the browser.
 *
 * And a canvas, for the one thing the exporter cannot do without one:
 * embedding a texture. `processImage` draws every image into a canvas and asks
 * it for a PNG, which is why the CLI used to ship the baked atlas *beside* the
 * GLB instead of inside it. The shim below is a canvas only in the sense that
 * a `DataTexture` needs: it holds the pixels `putImageData` hands it and
 * encodes them with the studio's own PNG writer. Nothing draws, nothing
 * composites, and nothing is scaled — if three ever asks it to, it says so
 * rather than returning an empty image.
 */
import { encodePng } from './asset-png';
type Reader = {
  result: ArrayBuffer | string | null;
  onloadend: (() => void) | null;
  onerror: ((reason: unknown) => void) | null;
};

export function installNodeShims() {
  if (typeof globalThis.FileReader !== 'undefined') return;
  class NodeFileReader implements Reader {
    result: ArrayBuffer | string | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((reason: unknown) => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then(
        (buffer) => {
          this.result = buffer;
          this.onloadend?.();
        },
        (reason) => this.onerror?.(reason),
      );
    }
    readAsDataURL(blob: Blob) {
      blob.arrayBuffer().then(
        (buffer) => {
          const type = blob.type || 'application/octet-stream';
          const base64 = Buffer.from(buffer).toString('base64');
          this.result = `data:${type};base64,${base64}`;
          this.onloadend?.();
        },
        (reason) => this.onerror?.(reason),
      );
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;
}

installNodeShims();

type Pixels = { data: Uint8ClampedArray; width: number; height: number };

class NodeImageData implements Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

/**
 * The 2D context, reduced to what `GLTFExporter.processImage` calls.
 *
 * `translate` and `scale` are accepted and ignored on purpose: the canvas spec
 * says `putImageData` is not affected by the current transform, so a browser
 * ignores them here too. Every texture this pipeline exports is written with
 * `flipY` off for exactly that reason — the flip is done to the pixels before
 * they ever reach a texture, where it actually happens.
 */
class NodeContext {
  readonly canvas: NodeOffscreenCanvas;
  constructor(canvas: NodeOffscreenCanvas) {
    this.canvas = canvas;
  }
  translate() {}
  scale() {}
  putImageData(image: Pixels, x: number, y: number) {
    if (x !== 0 || y !== 0)
      throw Error('NodeOffscreenCanvas: putImageData only writes whole images.');
    this.canvas.pixels = image;
  }
  getImageData(x: number, y: number, width: number, height: number) {
    const pixels = this.canvas.pixels;
    if (!pixels || x !== 0 || y !== 0 || width !== pixels.width || height !== pixels.height)
      throw Error('NodeOffscreenCanvas: getImageData only reads the whole image.');
    return pixels;
  }
  drawImage(): never {
    throw Error(
      'NodeOffscreenCanvas cannot draw images. Export textures as DataTextures under Node.',
    );
  }
}

class NodeOffscreenCanvas {
  width: number;
  height: number;
  pixels: Pixels | null = null;
  constructor(width = 1, height = 1) {
    this.width = width;
    this.height = height;
  }
  getContext(kind: string) {
    if (kind !== '2d') return null;
    return new NodeContext(this);
  }
  convertToBlob(options?: { type?: string }) {
    const type = options?.type ?? 'image/png';
    if (type !== 'image/png')
      throw Error(`NodeOffscreenCanvas writes PNG, not ${type}.`);
    if (!this.pixels) throw Error('NodeOffscreenCanvas has nothing to encode.');
    const png = encodePng({
      width: this.pixels.width,
      height: this.pixels.height,
      rgba: new Uint8Array(
        this.pixels.data.buffer,
        this.pixels.data.byteOffset,
        this.pixels.data.byteLength,
      ),
    });
    return Promise.resolve(new Blob([png as unknown as BlobPart], { type }));
  }
}

/**
 * Install the canvas shims. Safe to call anywhere: a browser and a worker both
 * have the real things, and neither is touched.
 */
export function installCanvasShims() {
  const global = globalThis as {
    OffscreenCanvas?: unknown;
    ImageData?: unknown;
    document?: unknown;
  };
  if (global.document !== undefined) return;
  if (global.OffscreenCanvas === undefined)
    global.OffscreenCanvas = NodeOffscreenCanvas;
  if (global.ImageData === undefined) global.ImageData = NodeImageData;
}

installCanvasShims();
