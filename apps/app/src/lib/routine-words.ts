const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAYS = '1,2,3,4,5';
const WEEKEND = '0,6';

const CRON_SHORTHAND: Record<string, string> = {
  '@reboot': 'When the server starts',
  '@hourly': 'Every hour',
  '@daily': 'Every day at 00:00',
  '@midnight': 'Every day at 00:00',
  '@weekly': 'Sundays at 00:00',
  '@monthly': 'On day 1 of each month at 00:00',
  '@yearly': 'Every year on 1 January at 00:00',
  '@annually': 'Every year on 1 January at 00:00',
};

const CALENDAR_SHORTHAND: Record<string, string> = {
  minutely: 'Every minute',
  hourly: 'Every hour',
  daily: 'Every day at 00:00',
  weekly: 'Mondays at 00:00',
  monthly: 'On day 1 of each month at 00:00',
  yearly: 'Every year on 1 January at 00:00',
  annually: 'Every year on 1 January at 00:00',
};

const UNITS: Record<string, [string, string]> = {
  s: ['second', 'seconds'],
  sec: ['second', 'seconds'],
  min: ['minute', 'min'],
  m: ['minute', 'min'],
  h: ['hour', 'hours'],
  d: ['day', 'days'],
  w: ['week', 'weeks'],
};

const NUMBER = /^\d{1,2}$/;
const pad = (n: string): string => n.padStart(2, '0');
const isNumber = (field: string): boolean => NUMBER.test(field);

function joinAnd(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

function dayIndex(token: string): number | null {
  const lower = token.toLowerCase().slice(0, 3);
  const named = SHORT.indexOf(lower);
  if (named >= 0) return named;
  if (!isNumber(token)) return null;
  const n = Number(token) % 7;
  return Number(token) > 7 ? null : n;
}

function expandDays(field: string, range: string): number[] | null {
  const out: number[] = [];
  for (const part of field.split(',')) {
    const [from, to] = part.split(range);
    const start = dayIndex(from ?? '');
    const end = to === undefined ? start : dayIndex(to);
    if (start === null || end === null || end < start) return null;
    for (let at = start; at <= end; at += 1) out.push(at);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function daysWords(field: string, range: string): string | null {
  const days = expandDays(field, range);
  if (days === null || days.length === 0) return null;
  const key = days.join(',');
  if (key === WEEKDAYS) return 'Weekdays';
  if (key === WEEKEND) return 'Weekends';
  if (days.length === 7) return 'Every day';
  return joinAnd(days.map((d) => DAYS[d] ?? ''));
}

function timesWords(minute: string, hours: string): string | null {
  if (!isNumber(minute)) return null;
  const list = hours.split(',');
  if (!list.every(isNumber)) return null;
  return joinAnd(list.map((h) => `${pad(h)}:${pad(minute)}`));
}

function everyMinutes(minute: string): string | null {
  if (minute === '*') return 'Every minute';
  const step = /^\*\/(\d+)$/.exec(minute)?.[1];
  if (step === undefined) return null;
  return step === '1' ? 'Every minute' : `Every ${step} min`;
}

function everyHours(minute: string, hour: string): string | null {
  if (!isNumber(minute)) return null;
  if (hour === '*') return 'Every hour';
  const step = /^\*\/(\d+)$/.exec(hour)?.[1];
  if (step === undefined) return null;
  return step === '1' ? 'Every hour' : `Every ${step} hours`;
}

interface Cron {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

const cronOf = (f: string[]): Cron => ({ minute: f[0] ?? '', hour: f[1] ?? '', dom: f[2] ?? '', month: f[3] ?? '', dow: f[4] ?? '' });

function dailyCron({ minute, hour, dom, dow }: Cron): string | null {
  const times = timesWords(minute, hour);
  if (times === null) return null;
  if (dom === '*' && dow === '*') return `Every day at ${times}`;
  if (dom === '*') {
    const days = daysWords(dow, '-');
    return days === null ? null : `${days} at ${times}`;
  }
  if (dow === '*' && isNumber(dom)) return `On day ${String(Number(dom))} of each month at ${times}`;
  return null;
}

function cronWords(cron: Cron): string | null {
  if (cron.month !== '*') return null;
  if (cron.dom !== '*' || cron.dow !== '*') return dailyCron(cron);
  const minutes = cron.hour === '*' ? everyMinutes(cron.minute) : null;
  return minutes ?? everyHours(cron.minute, cron.hour) ?? dailyCron(cron);
}

function calendarWords(text: string): string | null {
  const match = /^(?:([A-Za-z.,]+)\s+)?\*-\*-\*\s+(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (match === null) return null;
  const [, dayField, hour = '', minute = ''] = match;
  const at = `${pad(hour)}:${minute}`;
  if (dayField === undefined) return `Every day at ${at}`;
  const days = daysWords(dayField, '..');
  return days === null ? null : `${days} at ${at}`;
}

function spanWords(span: string, every: boolean): string | null {
  const parts = span.trim().split(/\s+/).map((part) => /^(\d+)([a-z]+)$/.exec(part));
  if (parts.some((p) => p === null || UNITS[p[2] ?? ''] === undefined)) return null;
  const words = parts.map((p) => {
    const count = p?.[1] ?? '';
    const [one, many] = UNITS[p?.[2] ?? ''] ?? ['', ''];
    if (count !== '1') return `${count} ${many}`;
    return every && parts.length === 1 ? one : `1 ${one}`;
  });
  return words.join(' ');
}

function monotonicWords(text: string): string | null {
  const match = /^(OnUnitActiveUSec|OnActiveUSec|OnBootUSec)=(.+)$/.exec(text);
  if (match === null) return null;
  const boot = match[1] === 'OnBootUSec';
  const span = spanWords(match[2] ?? '', !boot);
  if (span === null) return null;
  return boot ? `${span} after the server starts` : `Every ${span}`;
}

export function scheduleWords(schedule: string): string {
  const text = schedule.trim();
  const fields = text.split(/\s+/);
  const words =
    CRON_SHORTHAND[text.toLowerCase()] ??
    CALENDAR_SHORTHAND[text.toLowerCase()] ??
    monotonicWords(text) ??
    (fields.length === 5 ? cronWords(cronOf(fields)) : null) ??
    calendarWords(text);
  return words ?? text;
}

export function plainTitle(raw: string): string {
  const words = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}

export const routineTitle = (name: string): string => plainTitle(name.replace(/\.(sh|py|js|mjs|ts|md)$/i, '')) || name;
