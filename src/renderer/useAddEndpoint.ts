import { useCallback, useMemo } from 'react';
import type { AdapterId } from '../shared/adapter';
import type { GuiApi } from '../shared/gui-link';
import { api } from './api/client';
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

/** Shared preference boundary for the window's controls and next creation. */
export function useAgentPreference(mirror: TopicMirror, client: Pick<GuiApi, 'settingsSet'> = api) {
  const endpoint = useAddEndpoint(mirror);
  const set = useCallback(
    (adapter: AdapterId | null) => client.settingsSet({ defaultAdapter: adapter }),
    [client],
  );
  return { endpoint, ready: mirror.snapshot('settings') !== undefined, set };
}
