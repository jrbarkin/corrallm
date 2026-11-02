import { useState } from 'react';
import type { SyntheticEvent } from 'react';

import type { ElicitationAction, FormField, FormValue } from '../../shared/session';

/** A form an MCP server asks the user to fill in: Submit once what it requires is there. */
export function Form({
  server,
  message,
  fields,
  onAnswer,
  explicit = false,
}: {
  explicit?: boolean;
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
    <form
      className="agent-permission agent-form"
      aria-label={`${server} asks`}
      onKeyDown={(event) => {
        if (explicit && event.key === 'Enter') event.preventDefault();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!explicit) submit();
      }}
    >
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
        <button
          type={explicit ? 'button' : 'submit'}
          disabled={missing}
          onClick={
            explicit
              ? () => {
                  submit();
                }
              : undefined
          }
        >
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
