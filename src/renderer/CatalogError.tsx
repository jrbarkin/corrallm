import { useState } from 'react';

export function CatalogError({ retry }: { retry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div role="alert">
      <p>corrallm couldn’t load its agent catalog.</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void retry().finally(() => {
            setBusy(false);
          });
        }}
      >
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  );
}
