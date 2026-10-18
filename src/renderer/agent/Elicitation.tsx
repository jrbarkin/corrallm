import { useContext, useState } from 'react';
import type { SyntheticEvent } from 'react';

import type { ElicitationAction, FormField, FormValue } from '../../shared/session';
import { OpenLinkContext } from '../open-link';
import type { Entry } from '../../shared/model/session';

/**
 * An MCP server asking the user something (an elicitation), in the transcript: a form to fill in
 * ("github asks: Which repository should the issue go in?", its fields, then Submit, Decline or
 * Cancel), or a link to open ("Open linear.app", which goes to main, as any link does, or
 * Decline). Once answered, or no longer asked, a line says how it went.
 */
export function Elicitation({
  entry,
  onAnswer,
}: {
  entry: Extract<Entry, { kind: 'elicitation' }>;
  onAnswer: (action: ElicitationAction, values?: Record<string, FormValue>) => void;
}) {
  const openLink = useContext(OpenLinkContext);
  const { server, message, url, fields = [] } = entry;
  if (entry.answer !== undefined || entry.withdrawn === true) {
    const said =
      entry.answer === 'accept'
        ? url === undefined
          ? `Sent to ${server}`
          : `Opened for ${server}`
        : entry.answer === 'decline'
          ? 'Declined'
          : entry.answer === 'cancel'
            ? 'Cancelled'
            : 'Not answered';
    return (
      <p className="agent-permission-answer" data-answer={entry.answer ?? 'withdrawn'}>
        {said}: {message}
      </p>
    );
  }
  if (url !== undefined) {
    const host = hostOf(url);
    return (
      <div className="agent-permission" role="group" aria-label={`${server} asks`}>
        <p className="agent-permission-title">{server} asks</p>
        <p>{message}</p>
        <code className="agent-permission-summary">{url}</code>
        <div className="agent-permission-choices">
          <button
            type="button"
            onClick={() => {
              openLink(url);
              onAnswer('accept');
            }}
          >
            Open {host}
          </button>
          <button
            type="button"
            onClick={() => {
              onAnswer('decline');
            }}
          >
            Decline
          </button>
        </div>
      </div>
    );
  }
  return <Form server={server} message={message} fields={fields} onAnswer={onAnswer} />;
}

/** A form an MCP server asks the user to fill in: Submit once what it requires is there. */
function Form({
  server,
  message,
  fields,
  onAnswer,
}: {
  server: string;
  message: string;
  fields: readonly FormField[];
  onAnswer: (action: ElicitationAction, values?: Record<string, FormValue>) => void;
}) {
  /** What was typed or picked, by field: text as typed (numbers too), yes or no, choices. */
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>(() =>
    Object.fromEntries(fields.map((field) => [field.name, initial(field)])),
  );
  const set = (name: string, value: string | boolean | string[]) => {
    setValues((before) => ({ ...before, [name]: value }));
  };
  const missing = fields.some((field) => field.required && empty(values[field.name]));
  const submit = (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (missing) return;
    onAnswer('accept', answered(fields, values));
  };
  return (
    <form className="agent-permission agent-form" aria-label={`${server} asks`} onSubmit={submit}>
      <p className="agent-permission-title">{server} asks</p>
      <p>{message}</p>
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={values[field.name] ?? ''}
          onChange={(value) => {
            set(field.name, value);
          }}
        />
      ))}
      <div className="agent-permission-choices">
        <button type="submit" disabled={missing}>
          Submit
        </button>
        <button
          type="button"
          onClick={() => {
            onAnswer('decline');
          }}
        >
          Decline
        </button>
        <button
          type="button"
          onClick={() => {
            onAnswer('cancel');
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One field of the form, labelled, with what describes it under it. */
function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: string | boolean | string[];
  onChange: (value: string | boolean | string[]) => void;
}) {
  const label = `${field.label}${field.required ? ' *' : ''}`;
  const note = field.description !== undefined && (
    <span className="agent-form-note">{field.description}</span>
  );
  switch (field.kind) {
    case 'boolean':
      return (
        <label className="agent-form-check">
          <input
            type="checkbox"
            aria-label={field.label}
            checked={value === true}
            onChange={(event) => {
              onChange(event.target.checked);
            }}
          />
          {label}
          {note}
        </label>
      );
    case 'choice':
      return (
        <label className="agent-form-field">
          {label}
          <select
            aria-label={field.label}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          >
            <option value="">Choose…</option>
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {note}
        </label>
      );
    case 'choices': {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <fieldset className="agent-form-field">
          <legend>{label}</legend>
          {(field.options ?? []).map((option) => (
            <label key={option.value} className="agent-form-check">
              <input
                type="checkbox"
                aria-label={option.label}
                checked={chosen.includes(option.value)}
                onChange={(event) => {
                  onChange(
                    event.target.checked
                      ? [...chosen, option.value]
                      : chosen.filter((c) => c !== option.value),
                  );
                }}
              />
              {option.label}
            </label>
          ))}
          {note}
        </fieldset>
      );
    }
    default: {
      const numeric = field.kind === 'number' || field.kind === 'integer';
      return (
        <label className="agent-form-field">
          {label}
          <input
            type={numeric ? 'number' : inputType(field.format)}
            aria-label={field.label}
            value={typeof value === 'string' ? value : ''}
            {...(numeric
              ? {
                  step: field.kind === 'integer' ? 1 : 'any',
                  ...(field.min === undefined ? {} : { min: field.min }),
                  ...(field.max === undefined ? {} : { max: field.max }),
                }
              : {
                  ...(field.min === undefined ? {} : { minLength: field.min }),
                  ...(field.max === undefined ? {} : { maxLength: field.max }),
                })}
            {...(field.format === 'date-time' ? { placeholder: '2026-10-12T14:30:00Z' } : {})}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          {note}
        </label>
      );
    }
  }
}

/** The input a text field takes: an email address, a URL, a date, or any text. */
function inputType(format: FormField['format']): string {
  switch (format) {
    case 'email':
      return 'email';
    case 'uri':
      return 'url';
    case 'date':
      return 'date';
    default:
      return 'text';
  }
}

/** What a field starts as: its default, or empty. */
function initial(field: FormField): string | boolean | string[] {
  const given = field.default;
  switch (field.kind) {
    case 'boolean':
      return given === true;
    case 'choices':
      return Array.isArray(given) ? given : [];
    default:
      return given === undefined || Array.isArray(given) || typeof given === 'boolean'
        ? ''
        : String(given);
  }
}

function empty(value: string | boolean | string[] | undefined): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** The form's values to send: numbers as numbers, what was left empty left out. */
function answered(
  fields: readonly FormField[],
  values: Readonly<Record<string, string | boolean | string[]>>,
): Record<string, FormValue> {
  return Object.fromEntries(
    fields.flatMap((field): [string, FormValue][] => {
      const value = values[field.name];
      if (value === undefined || empty(value)) return [];
      if ((field.kind === 'number' || field.kind === 'integer') && typeof value === 'string') {
        const number = Number(value);
        return Number.isFinite(number) ? [[field.name, number]] : [];
      }
      return [[field.name, value]];
    }),
  );
}

/** A link's site, as the button names it ("linear.app"); the link itself if it has none. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
