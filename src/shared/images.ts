import type { ConnectionDescriptor } from './adapter';
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL, MAX_IMAGES } from './api/limits';
import { IMAGE_TYPES, imageBytes } from './session';
import type { ImageType, MessageImage } from './session';

/*
 * The images a message to a connection may carry (B16 C3): one pure check, shared by a composer's
 * draft, the core's admission of every route that carries image bytes, and the send itself. A
 * connection's descriptor can only narrow the platform's own ceilings (its kinds, 5 MiB an image,
 * 20 images and 20 MiB in all), never widen them; one declaring none takes none. Byte counts are
 * the images' decoded bytes, never their base64's length. A refusal changes nothing: what was
 * pasted stays with its message, whole, for another try.
 *
 * Keep this module free of Node, Electron and DOM imports, and of any agent's name.
 */

/** What a connection takes, within the platform's ceilings. */
export interface ImageLimits {
  types: readonly ImageType[];
  /** The most bytes one image may hold. */
  maxBytes: number;
  /** The most images in one message. */
  max: number;
  /** The most bytes of images in one message, together. */
  total: number;
}

/** What `declared` (a connection's `images`) takes, within the platform's ceilings; null: none. */
export function imageLimits(
  declared: ConnectionDescriptor['images'] | undefined,
): ImageLimits | null {
  if (declared === null || declared === undefined) return null;
  const types = IMAGE_TYPES.filter((type) => declared.types.includes(type));
  const max = Math.min(Math.max(0, Math.floor(declared.max)), MAX_IMAGES);
  const maxBytes = Math.min(Math.max(0, Math.floor(declared.maxBytes)), MAX_IMAGE_BYTES);
  if (types.length === 0 || max === 0 || maxBytes === 0) return null;
  return { types, maxBytes, max, total: MAX_IMAGE_TOTAL };
}

/** A byte count in words: “5 MB”, “200 KB”, “900 bytes”. */
export function bytesText(bytes: number): string {
  const unit = (size: number, name: string) => {
    const value = bytes / size;
    return `${String(Number.isInteger(value) ? value : Math.floor(value * 10) / 10)} ${name}`;
  };
  if (bytes >= 1024 * 1024) return unit(1024 * 1024, 'MB');
  if (bytes >= 1024) return unit(1024, 'KB');
  return `${String(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

/** Image kinds as words: “PNG and JPEG”. */
function kinds(types: readonly ImageType[]): string {
  const names = types.map((type) => type.slice('image/'.length).toUpperCase());
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * Why `images` can't go in one message to a connection that takes `declared`, in words naming the
 * limit that applies (`subject` says whose: an agent's connection, as a sentence names it); none
 * when they can. An image exactly at a limit passes; one byte or one image past it doesn't.
 */
export function imageRefusal(
  images: readonly Pick<MessageImage, 'mediaType' | 'data'>[],
  declared: ConnectionDescriptor['images'] | undefined,
  subject: string,
): string | undefined {
  if (images.length === 0) return undefined;
  const limits = imageLimits(declared);
  if (limits === null) return `${subject} takes no images.`;
  if (images.length > limits.max) {
    return `${subject} takes at most ${String(limits.max)} ${limits.max === 1 ? 'image' : 'images'} in a message.`;
  }
  if (images.some(({ mediaType }) => !(limits.types as readonly string[]).includes(mediaType))) {
    return `${subject} takes only ${kinds(limits.types)} images.`;
  }
  const sizes = images.map(({ data }) => imageBytes(data));
  if (sizes.some((size) => size > limits.maxBytes)) {
    return `${subject} takes images of at most ${bytesText(limits.maxBytes)} each.`;
  }
  if (sizes.reduce((sum, size) => sum + size, 0) > limits.total) {
    return `${subject} takes at most ${bytesText(limits.total)} of images in a message.`;
  }
  return undefined;
}
