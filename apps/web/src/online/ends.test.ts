import { describe, expect, it } from 'vitest';

import { endsLabel, postedLabel } from './ends.ts';

const HOUR = 60 * 60 * 1000;
/** Friday 25 September 2026, 10:00 on this machine's clock. */
const now = new Date(2026, 8, 25, 10, 0).getTime();

describe('endsLabel', () => {
  it('names the day and time, adding the date six days or more ahead', () => {
    expect(endsLabel(new Date(2026, 8, 27, 14, 0).getTime(), now)).toEqual({ text: 'Ends Sunday 14:00', soon: false });
    expect(endsLabel(new Date(2026, 9, 4, 9, 5).getTime(), now)).toEqual({ text: 'Ends Sunday 4 October 09:05', soon: false });
  });

  it('counts hours in the last day and minutes in the last hour, highlighted', () => {
    expect(endsLabel(now + 5 * HOUR + 40 * 60 * 1000, now)).toEqual({ text: 'Ends in 5 hours', soon: true });
    expect(endsLabel(now + 24 * HOUR, now)).toEqual({ text: 'Ends in 24 hours', soon: true });
    expect(endsLabel(now + HOUR, now)).toEqual({ text: 'Ends in 1 hour', soon: true });
    expect(endsLabel(now + 40 * 60 * 1000, now)).toEqual({ text: 'Ends in 40 minutes', soon: true });
    expect(endsLabel(now + 1000, now)).toEqual({ text: 'Ends in 1 minute', soon: true });
  });
});

describe('postedLabel (Q56, 59)', () => {
  it('gives the time alone today, the day before that, and the date six days or more back', () => {
    expect(postedLabel(new Date(2026, 8, 25, 0, 5).getTime(), now)).toBe('00:05');
    expect(postedLabel(new Date(2026, 8, 24, 23, 59).getTime(), now)).toBe('Thursday 23:59');
    expect(postedLabel(new Date(2026, 8, 20, 14, 2).getTime(), now)).toBe('Sunday 14:02');
    expect(postedLabel(new Date(2026, 8, 18, 14, 2).getTime(), now)).toBe('Friday 18 September 14:02');
  });
});
