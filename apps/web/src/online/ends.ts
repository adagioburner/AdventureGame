import { useEffect, useState } from 'react';
import { DAY_MS } from '@adventure/protocol';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * When a game's lifetime runs out, in words; `soon` in its last 24 hours, which are highlighted.
 * `short` is the shorter wording a phone shows, so the bar keeps one row ([Q72, 281]).
 */
export interface EndsLabel {
  readonly text: string;
  readonly short: string;
  readonly soon: boolean;
}

/**
 * [Q55, 46] "Ends Sunday 14:00"; in the last 24 hours "Ends in 5 hours",
 * highlighted. In this device's own time zone. A weekday alone names a day in
 * the coming six; further off, the date is added, since a game can last 14 days.
 *
 * [Q72, 281] On a phone: "Ends Sun 14:00", "Ends 4 Oct" six days or more ahead
 * (the time appears once it is closer), "Ends in 5 hours", "Ends in 40 min".
 */
export function endsLabel(endsAt: number, now: number): EndsLabel {
  const left = endsAt - now;
  if (left <= DAY_MS) {
    const hours = Math.floor(left / HOUR_MS);
    if (hours >= 1) {
      const text = `Ends in ${hours} hour${hours === 1 ? '' : 's'}`;
      return { text, short: text, soon: true };
    }
    const minutes = Math.max(1, Math.ceil(left / MINUTE_MS));
    return { text: `Ends in ${minutes} minute${minutes === 1 ? '' : 's'}`, short: `Ends in ${minutes} min`, soon: true };
  }
  const at = new Date(endsAt);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = WEEKDAYS[at.getDay()] ?? '';
  const month = MONTHS[at.getMonth()] ?? '';
  if (left < 6 * DAY_MS) return { text: `Ends ${day} ${time}`, short: `Ends ${day.slice(0, 3)} ${time}`, soon: false };
  return { text: `Ends ${day} ${at.getDate()} ${month} ${time}`, short: `Ends ${at.getDate()} ${month.slice(0, 3)}`, soon: false };
}

/**
 * [Q56, 59] When a post was written: "14:02" today, otherwise with the day,
 * "Tuesday 14:02", and six days or more back with the date as well, as an
 * end time further off has it ([Q56, 68]). In this device's own time zone.
 */
export function postedLabel(postedAt: number, now: number): string {
  const at = new Date(postedAt);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now);
  if (at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()) return time;
  const day = WEEKDAYS[at.getDay()] ?? '';
  const date = now - postedAt < 6 * DAY_MS ? '' : ` ${at.getDate()} ${MONTHS[at.getMonth()] ?? ''}`;
  return `${day}${date} ${time}`;
}

/** The time now, updated every minute, for labels that count down. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
