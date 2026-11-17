/** Minimal assertions for the scripts, which run outside `bun test`. */

export function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? "Assertion failed");
}

export function assertEqual(actual: unknown, expected: unknown, message?: string): void {
  if (!Bun.deepEquals(actual, expected, true)) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertMatch(actual: string | null, pattern: RegExp, message?: string): void {
  if (actual === null || !pattern.test(actual)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to match ${pattern}`);
  }
}
