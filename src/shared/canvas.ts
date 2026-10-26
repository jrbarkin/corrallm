/*
 * A canvas's identity, as every process reads it: a UUID kept in its `.corral` file (a draft's, in
 * its journal record). What main remembers of a canvas (its file, its project folder, its agents'
 * conversations) and its run's journal are kept by it, so the canvas keeps them when it is saved
 * elsewhere (Save As keeps its id), and a copy of its file opened as well gets an id of its own.
 */

declare const canvasId: unique symbol;
/** A canvas's stable identity: a UUID. */
export type CanvasId = string & { readonly [canvasId]: true };

/** The `.corral` format this version reads and writes; older and newer files are refused. */
export const CANVAS_VERSION = 2;

const FORMAT = 'corrallm';
const NOT_A_CANVAS = 'This is not a corrallm canvas';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCanvasId(value: unknown): value is CanvasId {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}

/** A new canvas's id. */
export function newCanvasId(): CanvasId {
  return crypto.randomUUID() as CanvasId;
}

/**
 * The id of the canvas a `.corral` file holds (as parsed JSON), once its format and version are
 * checked. Throws, saying what is wrong, for anything else.
 */
export function canvasHeader(file: unknown): CanvasId {
  if (typeof file !== 'object' || file === null || Array.isArray(file)) {
    throw new Error(NOT_A_CANVAS);
  }
  const { format, version, id } = file as Record<string, unknown>;
  if (format !== FORMAT) throw new Error(NOT_A_CANVAS);
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('version must be a whole number');
  }
  if (version > CANVAS_VERSION) {
    throw new Error('This canvas was made by a newer version of corrallm');
  }
  if (version < CANVAS_VERSION) {
    throw new Error('This canvas is from an older version of corrallm, which this one can’t open');
  }
  if (!isCanvasId(id)) throw new Error('id must be the canvas’s id (a UUID)');
  return id;
}

/** The id of the canvas a `.corral` file's text holds: `canvasHeader`, from the text. */
export function canvasIdOf(text: string): CanvasId {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error(NOT_A_CANVAS);
  }
  return canvasHeader(file);
}

/** A chosen project folder, for display; never accepted back from the page. */
export interface ProjectFolder {
  name: string;
  path: string;
}
export const CANVAS_EXTENSION = 'corral';
export const MAX_CANVAS_BYTES = 10 * 1024 * 1024;
