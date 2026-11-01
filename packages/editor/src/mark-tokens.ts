/**
 * The 0009 §1/§2 mark grammar, host side: a payloaded mark is the token
 * `<base>:<id>` in the marks arrays and its payload the same-keyed fields
 * entry. `baseOf` is the plugins package's grammar helper (0009's API
 * amendment); the two reads below are the rich host's projection of it.
 */
import { baseOf } from "@nooq/plugins/dom";
export { baseOf };

/** True when the mark carries an id half — a payloaded base never appears bare in stored marks. */
export function isToken(mark: string): boolean {
  return mark.indexOf(":") !== -1;
}

/**
 * The projection a renderer sees: sorted, unique, and at most one token per
 * base (the 0009 invariant hosts enforce on apply; the model may tolerate
 * more under concurrency, and the pick stays deterministic — the smallest
 * token of a base wins).
 */
export function normalizeMarks(names: readonly string[]): string[] {
  const seenBases = new Set<string>(), out: string[] = [];
  for (const name of [...new Set(names)].sort()) {
    if (!name) continue;
    const base = baseOf(name);
    if (isToken(name) && seenBases.has(base)) continue;
    seenBases.add(base);
    out.push(name);
  }
  return out;
}
