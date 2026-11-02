import { useMemo } from 'react';
import type { TopicMirror } from './api/topics';
import { useTopic } from './api/topics';
import { catalog } from './catalog';
import type { NewAgentEndpoint } from './graph/AddAgentChooser';

/** The preference applies only to the next explicit creation, never to an existing agent. */
export function useAddEndpoint(mirror: TopicMirror): NewAgentEndpoint | undefined {
  const settings = useTopic('settings', mirror);
  const preferred = settings?.defaultAdapter;
  return useMemo(() => {
    const adapter = catalog().adapters.find((one) => one.id === preferred);
    const connection = adapter?.connections[0];
    return adapter && connection ? { adapter: adapter.id, connection: connection.id } : undefined;
  }, [preferred]);
}
