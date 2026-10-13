/** Thrown when a caller violates a rule invariant (bad path, wrong turn, ...). */
export class RuleViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleViolationError';
  }
}

/** `never`-exhaustiveness helper for the discriminated unions below. */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
