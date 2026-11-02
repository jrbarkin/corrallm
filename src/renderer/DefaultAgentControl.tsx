import { useRef, useState } from 'react';
import type { AdapterId } from '../shared/adapter';
import type { GuiApi } from '../shared/gui-link';
import { api } from './api/client';
import { topics } from './api/topics';
import type { TopicMirror } from './api/topics';
import { catalog } from './catalog';
import { adapterName } from './graph/agents';
import { ipcErrorMessage } from './ipc-error';
import { SearchPicker } from './search/SearchPicker';
import { useAgentPreference } from './useAddEndpoint';
import './DefaultAgentControl.css';

/** One shared preference control; the topic alone determines the value shown. */
export function DefaultAgentControl({
  client = api,
  mirror = topics,
  disabled = false,
}: {
  client?: Pick<GuiApi, 'settingsSet'>;
  mirror?: TopicMirror;
  disabled?: boolean;
}) {
  const preference = useAgentPreference(mirror, client);
  const button = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const finish = () => {
    setEditing(false);
    button.current?.focus();
  };
  const choose = async (adapter: AdapterId | null) => {
    if (pending || disabled || !preference.ready) return;
    finish();
    setPending(true);
    setProblem(undefined);
    try {
      await preference.set(adapter);
    } catch (error) {
      setProblem(ipcErrorMessage(error));
    } finally {
      setPending(false);
    }
  };
  const unavailable = disabled || pending || !preference.ready;
  return (
    <section className="default-agent-control" aria-label="Default agent" aria-busy={pending}>
      <div className="default-agent-control-row">
        <span>
          {!preference.ready
            ? 'Loading default agent…'
            : preference.endpoint
              ? `Default agent: ${adapterName(preference.endpoint.adapter)}`
              : 'No default agent: corrallm asks each time'}
        </span>
        <button
          ref={button}
          type="button"
          disabled={unavailable}
          aria-expanded={editing}
          onClick={() => {
            setProblem(undefined);
            setEditing(!editing);
          }}
        >
          {preference.endpoint ? 'Change' : 'Choose…'}
        </button>
        {preference.endpoint && (
          <button
            type="button"
            disabled={unavailable}
            onClick={() => {
              void choose(null);
            }}
          >
            Clear
          </button>
        )}
      </div>
      {editing && (
        <SearchPicker
          label="Choose a default agent"
          options={catalog().adapters}
          optionLabel={(adapter) => adapter.name}
          optionKey={(adapter) => adapter.id}
          onPick={(adapter) => {
            void choose(adapter.id);
          }}
          onCancel={finish}
        />
      )}
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}
