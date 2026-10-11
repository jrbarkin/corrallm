import { useEffect, useState } from 'react';

type PingState =
  { status: 'pending' } | { status: 'ok'; version: string } | { status: 'error'; message: string };

export function App() {
  const [ping, setPing] = useState<PingState>({ status: 'pending' });

  useEffect(() => {
    let cancelled = false;
    window.api.ping().then(
      (version) => {
        if (!cancelled) setPing({ status: 'ok', version });
      },
      (error: unknown) => {
        if (!cancelled) {
          setPing({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>corrallm</h1>
      <p data-testid="ping-result" data-status={ping.status}>
        {ping.status === 'pending' && 'Pinging main process…'}
        {ping.status === 'ok' && ping.version}
        {ping.status === 'error' && `Ping failed: ${ping.message}`}
      </p>
    </main>
  );
}
