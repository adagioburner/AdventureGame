import { describe, expect, it } from 'vitest';

import { endsLabel } from './ends.ts';

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
