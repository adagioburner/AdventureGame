import { useEffect, useState } from 'react';
import { DAY_MS } from '@adventure/protocol';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** When a game's lifetime runs out, in words; `soon` in its last 24 hours, which are highlighted. */
export interface EndsLabel {
  readonly text: string;
  readonly soon: boolean;
}

/**
 * [Q55, 46] "Ends Sunday 14:00"; in the last 24 hours "Ends in 5 hours",
 * highlighted. In this device's own time zone. A weekday alone names a day in
 * the coming six; further off, the date is added, since a game can last 14 days.
 */
export function endsLabel(endsAt: number, now: number): EndsLabel {
  const left = endsAt - now;
  if (left <= DAY_MS) {
    const hours = Math.floor(left / HOUR_MS);
    if (hours >= 1) return { text: `Ends in ${hours} hour${hours === 1 ? '' : 's'}`, soon: true };
    const minutes = Math.max(1, Math.ceil(left / MINUTE_MS));
    return { text: `Ends in ${minutes} minute${minutes === 1 ? '' : 's'}`, soon: true };
  }
  const at = new Date(endsAt);
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = WEEKDAYS[at.getDay()] ?? '';
  const date = left < 6 * DAY_MS ? '' : ` ${at.getDate()} ${MONTHS[at.getMonth()] ?? ''}`;
  return { text: `Ends ${day}${date} ${time}`, soon: false };
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
