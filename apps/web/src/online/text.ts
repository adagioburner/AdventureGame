/** A server's refusal ("someone else in the game holds that figure") as a sentence for the page. */
export function sentence(message: string): string {
  const text = message.trim();
  if (text.length === 0) return 'Something went wrong.';
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** "first", "second"… for the seat legend, as on the hot seat panel. */
export function ordinal(seat: number): string {
  return ['first', 'second', 'third', 'fourth', 'fifth'][seat - 1] ?? `${seat}th`;
}
