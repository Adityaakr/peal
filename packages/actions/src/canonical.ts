/** Deterministic serialization.
 *
 * Everything that gets signed or hashed goes through here first. `JSON.stringify`
 * is not enough on its own: it preserves insertion order, so the same logical
 * intent built two different ways produces two different byte strings and two
 * different signatures. An agent that rebuilt its intent to retry would find the
 * receipt no longer verified against it.
 *
 * The rules, all of them load-bearing:
 *
 *  - object keys sorted by UTF-16 code unit (the JS default sort), recursively
 *  - no insignificant whitespace
 *  - `undefined` properties dropped; `null` kept and distinct from absent
 *  - only finite numbers; NaN and Infinity are rejected rather than becoming
 *    `null` the way JSON.stringify would
 *  - bigints rejected outright, so nobody can quietly serialize a uint256 as a
 *    lossy number — amounts travel as decimal strings instead
 *
 * This is JCS-shaped (RFC 8785) but deliberately narrower: it refuses anything
 * it cannot represent unambiguously instead of coercing it.
 */

function fail(msg: string): never {
  throw new Error(`cannot canonicalize: ${msg}`);
}

function enc(v: unknown, path: string): string {
  if (v === null) return 'null';

  switch (typeof v) {
    case 'string':
      // JSON.stringify on a lone string is already the canonical escaping:
      // shortest form, uppercase-free \u escapes only where required.
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) fail(`${path} is ${String(v)}, which has no JSON representation`);
      // Negative zero would serialize as "0" and compare equal to positive
      // zero, so two distinguishable inputs would hash identically.
      if (Object.is(v, -0)) return '0';
      return String(v);
    case 'bigint':
      fail(`${path} is a bigint; encode uint256 values as decimal strings`);
      break;
    case 'undefined':
      fail(`${path} is undefined and should have been dropped by its parent`);
      break;
    default:
      break;
  }

  if (Array.isArray(v)) {
    // Array order is meaningful and preserved. An undefined hole would become
    // null in JSON, so reject it rather than silently changing the value.
    return `[${v
      .map((x, i) => {
        if (x === undefined) fail(`${path}[${i}] is undefined`);
        return enc(x, `${path}[${i}]`);
      })
      .join(',')}]`;
  }

  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Object.getPrototypeOf(o) !== Object.prototype && Object.getPrototypeOf(o) !== null) {
      fail(`${path} is a class instance; only plain objects are canonicalizable`);
    }
    const parts: string[] = [];
    for (const k of Object.keys(o).sort()) {
      const val = o[k];
      if (val === undefined) continue; // absent, not null
      parts.push(`${JSON.stringify(k)}:${enc(val, `${path}.${k}`)}`);
    }
    return `{${parts.join(',')}}`;
  }

  return fail(`${path} has unsupported type ${typeof v}`);
}

/** Canonical JSON text for `value`. Stable across key insertion order. */
export function canonicalize(value: unknown): string {
  return enc(value, '$');
}
