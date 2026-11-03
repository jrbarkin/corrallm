import { describe, expect, it } from 'vitest';

import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL, MAX_IMAGES } from './api/limits';
import { bytesText, imageLimits, imageRefusal } from './images';
import type { ConnectionDescriptor } from './adapter';
import { imageBytes } from './session';
import type { MessageImage } from './session';

/** Base64 holding exactly `bytes` bytes (a multiple of 3, or one more). */
function data(bytes: number): string {
  const whole = Math.floor(bytes / 3);
  const rest = bytes - whole * 3;
  return 'AAAA'.repeat(whole) + (rest === 0 ? '' : rest === 1 ? 'AA==' : 'AAA=');
}
const png = (bytes: number) => ({ mediaType: 'image/png' as const, data: data(bytes) });

/** A made-up connection: PNG alone, 300 bytes an image, one image a message. */
const TINY = { types: ['image/png'], maxBytes: 300, max: 1 };

describe('imageLimits', () => {
  it('narrows the platform’s ceilings to what a connection declares, never widening them', () => {
    expect(imageLimits(TINY)).toEqual({
      types: ['image/png'],
      maxBytes: 300,
      max: 1,
      total: MAX_IMAGE_TOTAL,
    });
    expect(
      imageLimits({
        types: ['image/png', 'image/svg+xml', 'image/webp'],
        maxBytes: 10 * MAX_IMAGE_BYTES,
        max: 10 * MAX_IMAGES,
      }),
    ).toEqual({
      types: ['image/png', 'image/webp'],
      maxBytes: MAX_IMAGE_BYTES,
      max: MAX_IMAGES,
      total: MAX_IMAGE_TOTAL,
    });
  });

  it('takes none for a connection declaring none, or nothing usable', () => {
    expect(imageLimits(null)).toBeNull();
    expect(imageLimits(undefined)).toBeNull();
    expect(imageLimits({ types: [], maxBytes: 300, max: 1 })).toBeNull();
    expect(imageLimits({ types: ['image/svg+xml'], maxBytes: 300, max: 1 })).toBeNull();
    expect(imageLimits({ types: ['image/png'], maxBytes: 300, max: 0 })).toBeNull();
  });
});

describe('imageRefusal', () => {
  const refusal = (
    images: Pick<MessageImage, 'mediaType' | 'data'>[],
    declared: ConnectionDescriptor['images'] = TINY,
  ) => imageRefusal(images, declared, 'Builder’s connection');

  it('passes no images, and an image exactly at its limits', () => {
    expect(data(300)).toHaveLength(400);
    expect(imageBytes(data(301))).toBe(301);
    expect(refusal([])).toBeUndefined();
    expect(refusal([png(300)])).toBeUndefined();
  });

  it('refuses one byte or one image past a limit, in words naming that limit', () => {
    expect(refusal([png(301)])).toBe(
      'Builder’s connection takes images of at most 300 bytes each.',
    );
    expect(refusal([png(10), png(10)])).toBe(
      'Builder’s connection takes at most 1 image in a message.',
    );
    expect(refusal([{ mediaType: 'image/jpeg', data: data(10) }])).toBe(
      'Builder’s connection takes only PNG images.',
    );
    expect(refusal([png(10)], null)).toBe('Builder’s connection takes no images.');
  });

  it('holds a connection declaring more to the platform’s ceilings', () => {
    const generous = { types: ['image/png'], maxBytes: 10 * MAX_IMAGE_BYTES, max: 100 };
    expect(refusal([png(MAX_IMAGE_BYTES)], generous)).toBeUndefined();
    expect(refusal([png(MAX_IMAGE_BYTES + 1)], generous)).toBe(
      'Builder’s connection takes images of at most 5 MB each.',
    );
    const many = Array.from({ length: MAX_IMAGES + 1 }, () => png(1));
    expect(refusal(many, generous)).toBe(
      'Builder’s connection takes at most 20 images in a message.',
    );
    // Exactly the platform's total passes; past it, though each image is within its own bound, not.
    const quarter = png(MAX_IMAGE_TOTAL / 4);
    expect(refusal([quarter, quarter, quarter, quarter], generous)).toBeUndefined();
    const fifth = png(MAX_IMAGE_TOTAL / 5 + 3);
    expect(refusal([fifth, fifth, fifth, fifth, fifth], generous)).toBe(
      'Builder’s connection takes at most 20 MB of images in a message.',
    );
  });

  it('says sizes in words', () => {
    expect(bytesText(1)).toBe('1 byte');
    expect(bytesText(900)).toBe('900 bytes');
    expect(bytesText(200 * 1024)).toBe('200 KB');
    expect(bytesText(1536 * 1024)).toBe('1.5 MB');
  });
});
