/** A server's refusal ("someone else in the game holds that figure") as a sentence for the page. */
export function sentence(message: string): string {
  const text = message.trim();
  if (text.length === 0) return 'Something went wrong.';
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
