import { useState } from 'react';
import { OrchestratorId } from '../../shared/api/ids';
import type { GuiApi } from '../../shared/gui-link';
import type { OrchestratorIntent } from '../../shared/model/orchestrators';
import { api } from '../api/client';
import { topics, useTopic } from '../api/topics';
import type { TopicMirror } from '../api/topics';
import { ipcErrorMessage } from '../ipc-error';

type Client = Pick<GuiApi, 'settingsSet'>;
type Intent = OrchestratorIntent;
function Decision({
  id,
  allow = false,
  client,
  disabled,
}: {
  id: string;
  allow?: boolean;
  client: Client;
  disabled: boolean;
}) {
  const [withoutApprovals, setWithoutApprovals] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const send = (intent: Intent) => {
    if (pending || disabled) return;
    setPending(true);
    setError(undefined);
    void client
      .settingsSet({ orchestrator: intent })
      .catch((failure: unknown) => {
        setError(ipcErrorMessage(failure));
      })
      .finally(() => {
        setPending(false);
      });
  };
  return (
    <>
      {allow && (
        <label>
          <input
            type="checkbox"
            checked={withoutApprovals}
            disabled={pending || disabled}
            onChange={(event) => {
              setWithoutApprovals(event.target.checked);
            }}
          />
          may run agents without approvals
        </label>
      )}
      {allow ? (
        <>
          <button
            type="button"
            disabled={pending || disabled}
            onClick={() => {
              send({ action: 'allow', id: OrchestratorId.parse(id), withoutApprovals });
            }}
          >
            Allow
          </button>
          <button
            type="button"
            disabled={pending || disabled}
            onClick={() => {
              send({ action: 'decline', id: OrchestratorId.parse(id) });
            }}
          >
            Decline
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={pending || disabled}
          onClick={() => {
            send({ action: 'revoke', id: OrchestratorId.parse(id) });
          }}
        >
          Revoke
        </button>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
    </>
  );
}
/** Profile-wide Needs, including before the first canvas exists. No path in an answer. */
export function OrchestratorRequests({
  client = api,
  mirror = topics,
}: {
  client?: Client;
  mirror?: TopicMirror;
}) {
  const settings = useTopic('settings', mirror);
  const requests = settings?.orchestrators?.pending ?? [];
  if (requests.length === 0) return null;
  return (
    <aside aria-label="Needs you: orchestrator requests" className="orchestrator-requests">
      <h2>Needs you</h2>
      {requests.map((request) => (
        <article key={request.id} aria-label="Orchestrator request">
          <h3>{request.requester} asks to use corrallm</h3>
          <p>{request.folder}</p>
          <p>
            Allow read and write access to this folder’s canvas: create agents, edit queues, send
            work and merge changes. Backend changes and deletion still need your approval. Private
            prompts stay yours.
          </p>
          <p>
            Credential file: <code>{request.into}</code>
          </p>
          <p>This approval lasts until you revoke it in Settings.</p>
          <Decision
            id={request.id}
            allow
            client={client}
            disabled={mirror.revision('settings') === undefined}
          />
        </article>
      ))}
    </aside>
  );
}
export function ApprovedOrchestrators({
  client = api,
  mirror = topics,
}: {
  client?: Client;
  mirror?: TopicMirror;
}) {
  const settings = useTopic('settings', mirror);
  if (settings?.orchestrators === undefined) return null;
  return (
    <section aria-labelledby="settings-orchestrators">
      <h3 id="settings-orchestrators">Approved orchestrators</h3>
      <p>Revoking keeps the canvas and its agents.</p>
      {settings.orchestrators.approved.length === 0 ? (
        <p>No approved orchestrators.</p>
      ) : (
        <ul>
          {settings.orchestrators.approved.map((grant) => (
            <li key={grant.id}>
              <p>{grant.folder}</p>
              <p>
                Created {new Date(grant.created).toLocaleString()} · Last used{' '}
                {new Date(grant.lastUsed).toLocaleString()}
              </p>
              <Decision
                id={grant.id}
                client={client}
                disabled={mirror.revision('settings') === undefined}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
