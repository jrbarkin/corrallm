import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  const gl = {
    COLOR_BUFFER_BIT: 16384,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    NO_ERROR: 0,
    RENDERER: 7937,
    VERSION: 7938,
    clearColor: vi.fn(),
    clear: vi.fn(),
    readPixels: vi.fn(
      (
        _x: number,
        _y: number,
        _w: number,
        _h: number,
        _format: number,
        _type: number,
        pixel: Uint8Array,
      ) => {
        pixel.set([255, 0, 0, 255]);
      },
    ),
    getError: vi.fn(() => 0),
    isContextLost: vi.fn(() => false),
    getParameter: vi.fn((key: number) => (key === 7938 ? 'WebGL 2.0' : 'llvmpipe')),
    getExtension: vi.fn(),
  };
  const canvas = {
    width: 0,
    height: 0,
    addEventListener: vi.fn(),
    getContext: vi.fn((): typeof gl | null => gl),
  };
  const page = {
    waitForURL: vi.fn(),
    evaluate: vi.fn((probe: () => unknown) => Promise.resolve(probe())),
  };
  const close = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const launch = vi.fn(() => Promise.resolve({ app: { firstWindow: () => page }, close }));
  return { gl, canvas, page, close, launch };
});
vi.mock('../../e2e/launch', () => ({ launchApp: fakes.launch }));

import { checkWebGL2 } from '../../e2e/webgl';

beforeEach(() => {
  vi.clearAllMocks();
  fakes.canvas.getContext.mockReturnValue(fakes.gl);
  fakes.gl.getError.mockReturnValue(0);
  fakes.gl.isContextLost.mockReturnValue(false);
  fakes.gl.readPixels.mockImplementation((_x, _y, _w, _h, _format, _type, pixel) => {
    pixel.set([255, 0, 0, 255]);
  });
  vi.stubGlobal('document', { createElement: () => fakes.canvas });
  vi.spyOn(console, 'log').mockImplementation(() => {
    // Keep the preflight's successful diagnostic out of unit-test output.
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('checks WebGL2 drawing in the app renderer, reports the driver and closes the probe app', async () => {
  await checkWebGL2();
  expect(fakes.launch).toHaveBeenCalledOnce();
  expect(fakes.page.waitForURL).toHaveBeenCalledWith(/^app:\/\/main_window\//);
  expect(fakes.canvas.getContext).toHaveBeenCalledWith('webgl2', {
    antialias: false,
    depth: false,
    preserveDrawingBuffer: true,
  });
  expect(fakes.gl.readPixels).toHaveBeenCalledOnce();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('llvmpipe'));
  expect(fakes.close).toHaveBeenCalledOnce();
});

it('fails clearly and closes the probe app if WebGL2 is unavailable', async () => {
  fakes.canvas.getContext.mockReturnValue(null);
  await expect(checkWebGL2()).rejects.toThrow(/E2E WebGL2 preflight failed:.*unavailable/);
  expect(fakes.close).toHaveBeenCalledOnce();
});

it.each(['pixels', 'error', 'lost'])(
  'rejects a context that exists but cannot render correctly (%s)',
  async (fault) => {
    if (fault === 'pixels')
      fakes.gl.readPixels.mockImplementation(() => {
        // A broken renderer leaves the initially zero-filled pixel unchanged.
      });
    if (fault === 'error') fakes.gl.getError.mockReturnValue(1282);
    if (fault === 'lost') fakes.gl.isContextLost.mockReturnValue(true);
    await expect(checkWebGL2()).rejects.toThrow(/E2E WebGL2 preflight failed:.*readback/);
    expect(fakes.close).toHaveBeenCalledOnce();
  },
);
