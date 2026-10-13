import { MAX_SECONDS } from './queue';
import type { Time } from './queue';

/*
 * Times as the queue has them (queue.ts: Time), read from what the user types and put in words.
 * Lengths are whole seconds; times of day are local, 24-hour "HH:MM", and mean the next time the
 * clock shows that.
 */

/** The times a picker offers before anything is typed. */
export const TIME_PRESETS: readonly Time[] = [
  { seconds: 5 * 60 },
  { seconds: 10 * 60 },
  { seconds: 30 * 60 },
  { seconds: 60 * 60 },
  { seconds: 4 * 60 * 60 },
  { at: '09:00' },
];

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Units of length, by every name they are typed as, in seconds. */
const UNITS: Readonly<Record<string, number>> = Object.fromEntries(
  (
    [
      [1, ['s', 'sec', 'secs', 'second', 'seconds']],
      [MINUTE, ['m', 'min', 'mins', 'minute', 'minutes']],
      [HOUR, ['h', 'hr', 'hrs', 'hour', 'hours']],
      [DAY, ['d', 'day', 'days']],
      [WEEK, ['w', 'wk', 'wks', 'week', 'weeks']],
    ] as const
  ).flatMap(([size, names]) => names.map((name) => [name, size])),
);

/** After a unit, a number without one counts in the next smaller unit: "1h30" is 90 minutes. */
const NEXT_UNIT: Readonly<Record<number, number>> = {
  [WEEK]: DAY,
  [DAY]: HOUR,
  [HOUR]: MINUTE,
  [MINUTE]: 1,
};

/** One part of a length: a number and its unit, then what may join it to the next part. */
const PART = /(\d+(?:\.\d+)?) ?([a-z]+)?[ ,]*(?:and )?/y;

/**
 * The times `text` can mean, most likely first; none if it means none in range. Lengths read as
 * "10", "10m", "10 min", "1h30", "1.5 hours", "90s" or "2 days", after an optional "wait", "for"
 * or "in"; times of day as "until 9", "at 21:00", "9:30", "9am", "noon" or "midnight". A bare
 * number may be any of them: minutes, then hours, then seconds, then that hour of the day.
 */
export function parseTime(text: string): Time[] {
  let rest = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^wait\b ?/, '');
  const until = /^(?:until|till|at)\b ?/.exec(rest);
  if (until) {
    const at = clockOf(rest.slice(until[0].length), true);
    return at === undefined ? [] : [{ at }];
  }
  rest = rest.replace(/^(?:for|in)\b ?/, '');
  if (/^\d+(?:\.\d+)?$/.test(rest)) {
    const n = Number(rest);
    const at = clockOf(rest, true);
    return [
      ...[n * MINUTE, n * HOUR, n].flatMap((seconds) => {
        const whole = inRange(seconds);
        return whole === undefined ? [] : [{ seconds: whole }];
      }),
      ...(at === undefined ? [] : [{ at }]),
    ];
  }
  const at = clockOf(rest, false);
  if (at !== undefined) return [{ at }];
  const seconds = lengthOf(rest);
  return seconds === undefined ? [] : [{ seconds }];
}

/** A length typed in units ("1 hour 30 minutes", "1h30"), in whole seconds in range. */
function lengthOf(text: string): number | undefined {
  let total = 0;
  let unit: number | undefined;
  for (let at = 0; at < text.length;) {
    PART.lastIndex = at;
    const part = PART.exec(text);
    if (!part) return undefined;
    at = PART.lastIndex;
    const [, number = '', name] = part;
    // A number without a unit only ends a length.
    if (name === undefined && at < text.length) return undefined;
    unit = name === undefined ? (unit === undefined ? undefined : NEXT_UNIT[unit]) : UNITS[name];
    if (unit === undefined) return undefined;
    total += Number(number) * unit;
  }
  return inRange(total);
}

/** `seconds` as a whole number from 1 to MAX_SECONDS, or undefined if it is not one. */
function inRange(seconds: number): number | undefined {
  const whole = Math.round(seconds);
  return Math.abs(seconds - whole) < 1e-6 && whole >= 1 && whole <= MAX_SECONDS ? whole : undefined;
}

/**
 * A time of day typed as "9:30", "9am", "9:30 p.m.", "noon" or "midnight" (or, with `bare`, just
 * an hour, "21"), as "HH:MM"; undefined if it is not one.
 */
function clockOf(text: string, bare: boolean): string | undefined {
  if (text === 'noon') return '12:00';
  if (text === 'midnight') return '00:00';
  const meridiem = /^(\d{1,2})(?::(\d{2}))? ?([ap])\.?(?:m\.?)?$/.exec(text);
  if (meridiem) {
    const [, hour = '', minute = '00', half] = meridiem;
    const h = Number(hour);
    if (h < 1 || h > 12) return undefined;
    return hhmm((h % 12) + (half === 'p' ? 12 : 0), Number(minute));
  }
  const clock = (bare ? /^(\d{1,2})(?::(\d{2}))?$/ : /^(\d{1,2}):(\d{2})$/).exec(text);
  if (!clock) return undefined;
  const [, hour = '', minute = '00'] = clock;
  return hhmm(Number(hour), Number(minute));
}

function hhmm(hours: number, minutes: number): string | undefined {
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const LENGTH_WORDS = [
  [DAY, 'day'],
  [HOUR, 'hour'],
  [MINUTE, 'minute'],
  [1, 'second'],
] as const;

/** A time in words: "10 minutes", "1 hour 30 minutes", "until 9:00 AM" (in `locale`'s way). */
export function timeText(time: Time, locale?: string): string {
  if ('at' in time) return `until ${clockText(time.at, locale)}`;
  let left = time.seconds;
  const words: string[] = [];
  for (const [size, word] of LENGTH_WORDS) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n > 0) words.push(`${String(n)} ${word}${n === 1 ? '' : 's'}`);
  }
  return words.join(' ');
}

/** A time limit in words: "at most 30 minutes", "no later than 6:00 PM". */
export function limitText(time: Time, locale?: string): string {
  return 'at' in time ? `no later than ${clockText(time.at, locale)}` : `at most ${timeText(time)}`;
}

/** A time of day ("HH:MM") as `locale` shows one: "9:00 AM", "09:00". */
function clockText(at: string, locale: string | undefined): string {
  const [hours = 0, minutes = 0] = at.split(':').map(Number);
  return (
    new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
      .format(new Date(2000, 0, 1, hours, minutes))
      // Some locales put a narrow no-break space before AM and PM.
      .replace(/\s/gu, ' ')
  );
}

/** How long is left, `ms`, as a countdown shows it: "4:05 left", or "8 h 12 min left" from an hour. */
export function leftText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < HOUR) {
    return `${String(Math.floor(seconds / MINUTE))}:${String(seconds % MINUTE).padStart(2, '0')} left`;
  }
  return `${String(Math.floor(seconds / HOUR))} h ${String(Math.floor((seconds % HOUR) / MINUTE))} min left`;
}

/**
 * When a time comes (epoch ms), for a queue that reached it at `since`: a length later, or the next
 * time the local clock shows the time of day, strictly after `since`. The day is moved by the
 * calendar, not by 24 hours, so a change to or from daylight saving time keeps the time of day.
 */
export function deadline(time: Time, since: number): number {
  if ('seconds' in time) return since + time.seconds * 1000;
  const [hours = 0, minutes = 0] = time.at.split(':').map(Number);
  const day = new Date(since);
  day.setHours(hours, minutes, 0, 0);
  if (day.getTime() <= since) {
    day.setDate(day.getDate() + 1);
    day.setHours(hours, minutes, 0, 0);
  }
  return day.getTime();
}

/** Whether two times are the same. */
export function sameTime(a: Time, b: Time): boolean {
  return 'at' in a ? 'at' in b && a.at === b.at : 'seconds' in b && a.seconds === b.seconds;
}
