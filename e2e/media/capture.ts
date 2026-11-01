import { execFileSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

/*
 * Pictures of the hidden app's window for the README: a drawn pointer (the window never meets the
 * real one), screenshots squeezed into a palette, and a recording turned into a GIF. ffmpeg is
 * found on PATH, or where FFMPEG names it.
 */

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

/** An arrow pointer, drawn where the mouse Playwright moves is, while shown. */
const POINTER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
      '<path d="M3 2 L3 19 L7.5 14.8 L10.6 21.6 L13.6 20.3 L10.6 13.6 L16.8 13.6 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  );

/** Adds the pointer to the page, hidden until `showPointer`. */
export async function addPointer(page: Page): Promise<void> {
  await page.evaluate((src) => {
    const pointer = document.createElement('img');
    pointer.id = 'media-pointer';
    pointer.src = src;
    pointer.alt = '';
    Object.assign(pointer.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '24px',
      height: '24px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      display: 'none',
      filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35))',
    });
    document.body.append(pointer);
    window.addEventListener(
      'mousemove',
      (event) => {
        pointer.style.transform = `translate(${String(event.clientX - 3)}px, ${String(event.clientY - 2)}px)`;
      },
      true,
    );
  }, POINTER);
}

export async function showPointer(page: Page, shown: boolean): Promise<void> {
  await page.evaluate((shown) => {
    const pointer = document.getElementById('media-pointer');
    if (pointer) pointer.style.display = shown ? 'block' : 'none';
  }, shown);
}

/** Glides the mouse to `to` over `ms`, as a hand would, and returns when it is there. */
export async function glide(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  ms = 600,
): Promise<void> {
  const steps = Math.max(2, Math.round(ms / 40));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
    await page.waitForTimeout(ms / steps);
  }
}

/**
 * A screenshot of the window at its device pixels, kept in `scratch` as it is: the returned
 * function writes it to `file` as an 8-bit palette PNG (later, so encoding never holds up what the
 * page does next), and gives its size in bytes.
 */
export async function screenshot(page: Page, file: string, scratch: string): Promise<() => number> {
  const raw = path.join(scratch, `${path.basename(file, '.png')}-raw.png`);
  await page.screenshot({ path: raw, animations: 'allow' });
  return () => {
    ffmpeg(
      '-i',
      raw,
      '-vf',
      'split[a][b];[a]palettegen=max_colors=256:reserve_transparent=0[p];[b][p]paletteuse=dither=none',
      '-frames:v',
      '1',
      file,
    );
    return statSync(file).size;
  };
}

interface Frame {
  file: string;
  /** Seconds, by the screencast's clock. */
  time: number;
}

/** What a recording holds: its frames, and when (by their clock) the GIF starts and ends. */
export interface Recording {
  frames: Frame[];
  start: number;
  end: number;
}

/**
 * Starts recording the page through the DevTools screencast (Playwright's CDP session), frames
 * written to `scratch`: at most 20 a second and 1440 pixels wide, light enough not to slow the
 * other commands sharing the connection. `begin` marks where the GIF starts (by default, where the
 * recording did); `stop` ends it, for `toGif`.
 */
export async function record(
  page: Page,
  scratch: string,
): Promise<{ begin: () => void; stop: () => Promise<Recording> }> {
  const cdp = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  /** The screencast's clock less this one's, from the first frame (theirs may not be Unix time). */
  let skew: number | undefined;
  let stopped = false;
  const started = Date.now() / 1000;
  let begun = started;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    if (stopped) return;
    const now = Date.now() / 1000;
    const time = metadata.timestamp ?? now;
    skew ??= time - now;
    const file = path.join(scratch, `frame-${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, time });
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 90,
    maxWidth: 1440,
    maxHeight: 900,
    everyNthFrame: 3,
  });
  return {
    begin: () => {
      begun = Date.now() / 1000;
    },
    stop: async () => {
      stopped = true;
      const end = Date.now() / 1000;
      await cdp.send('Page.stopScreencast');
      await cdp.detach();
      return { frames, start: begun + (skew ?? 0), end: end + (skew ?? 0) };
    },
  };
}

/**
 * Turns a recording into a looping GIF `width` pixels wide at `fps`, from its start to its end,
 * through ffmpeg's palette filters, written to `file`: its size in bytes, and how long it lasts.
 */
export function toGif(
  { frames, start, end }: Recording,
  file: string,
  scratch: string,
  { fps = 12, width = 960 } = {},
): { bytes: number; seconds: number } {
  // The frame showing at the start, then each later one; each lasts until the next (the
  // screencast sends one only when the page changes).
  const first = frames.findLastIndex((frame) => frame.time <= start);
  const shown = frames.slice(Math.max(0, first));
  if (shown.length === 0) throw new Error('The recording has no frames.');
  const list = path.join(scratch, 'frames.txt');
  const lines = ['ffconcat version 1.0'];
  shown.forEach((frame, i) => {
    const from = Math.max(frame.time, start);
    const next = shown[i + 1]?.time ?? end;
    lines.push(`file '${frame.file}'`, `duration ${Math.max(0.001, next - from).toFixed(4)}`);
  });
  // The concat demuxer takes the last file's duration only if it is listed again.
  lines.push(`file '${shown[shown.length - 1]?.file ?? ''}'`);
  writeFileSync(list, `${lines.join('\n')}\n`);
  ffmpeg(
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-vf',
    `fps=${String(fps)},scale=${String(width)}:-2:flags=lanczos,split[a][b];` +
      '[a]palettegen=max_colors=256:stats_mode=full[p];' +
      '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop',
    '0',
    file,
  );
  return { bytes: statSync(file).size, seconds: end - start };
}

function ffmpeg(...args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}
