/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) Implementation
 * Ensures deterministic byte representation of JSON payloads regardless of property insertion order.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("RFC 8785 Error: Cannot canonicalize non-finite numbers (NaN, Infinity)");
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? "null" : canonicalizeJson(item)));
    return `[${items.join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function" && typeof obj[k] !== "symbol")
    .sort();

  const members = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
  return `{${members.join(",")}}`;
}
