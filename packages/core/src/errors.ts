/**
 * Marks a seam that is deliberately unimplemented in this architecture pass.
 * `gdd` points at the section the next session must implement against.
 */
export class NotImplementedError extends Error {
  readonly gdd: string;
  constructor(what: string, gdd: string) {
    super(`Not implemented: ${what} (see ${gdd})`);
    this.name = 'NotImplementedError';
    this.gdd = gdd;
  }
}

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
