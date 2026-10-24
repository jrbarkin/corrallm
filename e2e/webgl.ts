import { launchApp } from './launch';

/** Fail once, before any specs, if xterm's required rendering path is unavailable. */
export async function checkWebGL2(): Promise<void> {
  const { app, close } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^app:\/\/main_window\//);
    const result = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      let creationError = '';
      canvas.addEventListener('webglcontextcreationerror', (event) => {
        creationError = (event as WebGLContextEvent).statusMessage;
      });
      // xterm's context kind and antialias/depth settings; retain pixels for the diagnostic.
      const gl = canvas.getContext('webgl2', {
        antialias: false,
        depth: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) return { ok: false, detail: `WebGL2 unavailable. ${creationError}` };
      try {
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
        const version = String(gl.getParameter(gl.VERSION));
        const pixel = new Uint8Array(4);
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const ok =
          !gl.isContextLost() &&
          gl.getError() === gl.NO_ERROR &&
          pixel[0] === 255 &&
          pixel[1] === 0 &&
          pixel[2] === 0 &&
          pixel[3] === 255;
        return { ok, detail: `${renderer}; ${version}${ok ? '' : '; pixel readback failed'}` };
      } finally {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    });
    if (!result.ok) {
      throw new Error(
        `E2E WebGL2 preflight failed: ${result.detail}\n` +
          'Terminals require working WebGL2 under the production CSP. ' +
          'For Linux Docker, use scripts/ci-linux.sh (Mesa llvmpipe, EGL/GLX and Xvfb); ' +
          'inspect glxinfo -B inside that display if it fails. No specs were started.',
      );
    }
    console.log(`[e2e] WebGL2 ready: ${result.detail}`);
  } finally {
    await close();
  }
}
