import { adapterIn } from '../../shared/adapter';
import type { AdapterId } from '../../shared/adapter';
import type { Mode } from '../../shared/model/session';
import { catalog } from '../catalog';

export interface ModeInfo {
  mode: Mode;
  label: string;
  description: string;
}

/** Modes in their adapter's declared order.
 * The session protocol still types its native modes as a closed union; the descriptor supplies
 * those ids at this display boundary, and the core validates a requested mode against it.
 */
export function modesOf(adapter: AdapterId): readonly ModeInfo[] {
  return (
    adapterIn(catalog(), adapter)?.modes.map(({ id, label, description }) => ({
      mode: id as Mode,
      label,
      description,
    })) ?? []
  );
}

/** Shift+Tab cycles only modes the adapter classifies as asking. */
export function cycledModes(adapter: AdapterId): readonly Mode[] {
  return (
    adapterIn(catalog(), adapter)
      ?.modes.filter(({ asks }) => asks)
      .map(({ id }) => id as Mode) ?? []
  );
}

export function modeOf(adapter: AdapterId, mode: Mode): ModeInfo {
  return (
    modesOf(adapter).find((one) => one.mode === mode) ?? { mode, label: mode, description: '' }
  );
}
