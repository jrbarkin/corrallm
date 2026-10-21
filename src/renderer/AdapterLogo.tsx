import { adapterIn } from '../shared/adapter';
import type { AdapterId } from '../shared/adapter';
import { catalog } from './catalog';
import './AdapterLogo.css';

/** An adapter's own mark, isolated as an image; a missing mark gets its name's first letter. */
export function AdapterLogo({ adapter, size }: { adapter: AdapterId; size: 15 | 16 | 18 | 30 }) {
  const descriptor = adapterIn(catalog(), adapter);
  const name = descriptor?.name ?? adapter;
  return descriptor?.logo === undefined ? (
    <span
      className="adapter-logo adapter-logo-fallback"
      role="img"
      aria-label={name}
      data-size={size}
      data-accent={descriptor?.accent ?? 0}
    >
      {Array.from(name)[0]?.toLocaleUpperCase()}
    </span>
  ) : (
    <img
      className="adapter-logo"
      src={`data:image/svg+xml,${encodeURIComponent(descriptor.logo)}`}
      alt={name}
      width={size}
      height={size}
      draggable={false}
    />
  );
}
