/**
 * Canonical bytes — DM-2. RFC 8785 (JCS) canonical JSON.
 * Identity rules adapted from gooi protocol/identity.md (lineage stated
 * in DOCUMENT-MODEL.md).
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/** Serialize a JSON value to RFC 8785 canonical form. Throws CanonicalJsonError on non-JSON values. */
export function canonicalJson(value: unknown): string {
  return serialize(value, []);
}

function serialize(value: unknown, ancestors: readonly unknown[]): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(`Not a JSON value: ${typeof value}`);
  }
  if (ancestors.includes(value)) throw new CanonicalJsonError("Cycle detected");

  const stack = [...ancestors, value];
  if (Array.isArray(value)) {
    // Holes and undefined are not JSON; includes() sees holes as undefined.
    if (value.includes(undefined)) throw new CanonicalJsonError("Sparse array or undefined element");
    return "[" + value.map((element) => serialize(element, stack)).join(",") + "]";
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    throw new CanonicalJsonError("Only plain objects are allowed");
  }
  const record = value as Record<string, unknown>;
  // Default string comparison sorts by UTF-16 code units, per RFC 8785 §3.2.3.
  const keys = Object.keys(record).sort();
  return "{" + keys.map((key) => `${serializeString(key)}:${serialize(record[key], stack)}`).join(",") + "}";
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) throw new CanonicalJsonError("Non-finite number");
  // ECMAScript number-to-string is the JCS serialization (§3.2.2.3);
  // JSON.stringify gives exactly that, and -0 serializes as "0".
  return JSON.stringify(n);
}

function serializeString(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalJsonError("Lone high surrogate");
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonicalJsonError("Lone low surrogate");
    }
  }
  // Well-formed JSON.stringify escaping matches JCS string serialization.
  return JSON.stringify(s);
}
