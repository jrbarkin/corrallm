import { useState } from 'react';

import { recordWords } from '../../shared/model/records';
import type { RecordEntryView } from '../../shared/model/records';
import type { Entry } from '../../shared/model/session';
import type { OwnerPromptEntry } from './PromptCard';
import { PromptCard } from './PromptCard';
import { endedPrompt, MAX_SETTLED, PLAIN_NAMES, recordOf, shownRecords } from './records';
import type { Names } from './records';

/*
 * Settled records in the window (B19 X3), shared by a connected agent's transcript and a Terminal
 * agent's bar. A record is the core's typed display entry for how something ended (a run hold you
 * answered, an ask that ended, a native decision made while this core was not running): its line
 * is the core's words (`recordWords`), with nothing to answer, approve or send. An owner entry for
 * the same native decision, settled in place (B13), is that decision's only line: records of a
 * Needs item an owner entry holds are dropped here as well as in the core, so neither a reload nor
 * a topic racing the other can show one decision twice.
 */

/** One settled record, as a line: how it ended and who decided, never what was said. */
export function RecordLine({
  entry,
  names = PLAIN_NAMES,
  onHide,
}: {
  entry: RecordEntryView;
  names?: Names;
  /** Hides this line from this view only: no operation, nothing reopened. */
  onHide?: () => void;
}) {
  return (
    <p
      className="agent-record"
      role="note"
      data-record={entry.record.type}
      data-state={entry.state}
    >
      <span className="agent-record-words">{recordWords(entry, names)}</span>
      {onHide && <button type="button" aria-label="Hide" title="Hide this line" onClick={onHide} />}
    </p>
  );
}

/**
 * The settled lines of a Terminal agent's bar: the newest `MAX_SETTLED` of its records and of its
 * owner entries that have ended, each drawn as the transcript draws it (an ended owner entry by its
 * prompt card, a record by its line), apart from the live prompts, with a Hide on each that only
 * this view remembers.
 */
export function SettledLines({
  entries,
  names = PLAIN_NAMES,
}: {
  entries: readonly Entry[];
  names?: Names;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const records = new Set(shownRecords(entries).map(({ id }) => id));
  const settled = entries
    .filter((entry) => endedPrompt(entry) || records.has(entry.id))
    .filter((entry) => !hidden.has(entry.id))
    .slice(-MAX_SETTLED);
  if (settled.length === 0) return null;
  return (
    <div className="agent-settled" role="group" aria-label="Settled">
      {settled.map((entry) => {
        const record = recordOf(entry);
        return record === undefined ? (
          <div key={entry.id} className="agent-settled-prompt">
            <PromptCard
              entry={entry as OwnerPromptEntry}
              onReply={() => Promise.reject(new Error('The prompt is no longer waiting.'))}
            />
            <button
              type="button"
              className="agent-settled-hide"
              aria-label="Hide"
              title="Hide this line"
              onClick={() => {
                setHidden(new Set(hidden).add(entry.id));
              }}
            />
          </div>
        ) : (
          <RecordLine
            key={entry.id}
            entry={record}
            names={names}
            onHide={() => {
              setHidden(new Set(hidden).add(entry.id));
            }}
          />
        );
      })}
    </div>
  );
}
