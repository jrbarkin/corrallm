import { adapterIn } from '../shared/adapter';
import type { AdapterId } from '../shared/adapter';
import { adapterAccent, catalog } from './catalog';
import './AdapterLogo.css';

/** An adapter's own mark, isolated as an image; a missing mark gets its name's first letter. */
export function AdapterLogo({
  adapter,
  size,
}: {
  adapter: AdapterId | undefined;
  size: 15 | 16 | 18 | 30;
}) {
  const descriptor = adapterIn(catalog(), adapter);
  const name = descriptor?.name ?? adapter ?? 'Choose an agent';
  if (adapter === undefined)
    return (
      <span
        className="adapter-logo adapter-logo-fallback"
        role="img"
        aria-label={name}
        data-size={size}
      >
        ○
      </span>
    );
  return descriptor?.logo === undefined ? (
    <span
      className="adapter-logo adapter-logo-fallback"
      role="img"
      aria-label={name}
      data-size={size}
      data-accent={adapterAccent(adapter)}
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
