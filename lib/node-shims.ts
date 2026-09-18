/**
 * Minimal DOM shims so three.js exporters run under Node.
 *
 * `GLTFExporter` reads blobs through `FileReader`, which Node does not expose
 * as a global. Everything else it needs (`Blob`, `TextEncoder`, `btoa`) is
 * already built in from Node 18 onwards. Import this module once, before the
 * exporters, from any headless entry point (CLI, MCP server, tests). It is a
 * no-op in the browser.
 */
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
