/** Short link names, and the rules they have to satisfy.
 *
 * These mirror `contracts/src/PealNames.sol` exactly, on purpose and with a
 * test that says so. The contract is the authority; this exists so somebody
 * typing a name learns it is taken or malformed by reading a sentence, rather
 * than by paying for a reverted transaction and decoding a custom error. Two
 * implementations of one rule is a thing that drifts, so when the contract's
 * validation changes this has to change with it.
 */

export const MIN_NAME_CHARS = 3;
export const MAX_NAME_CHARS = 32;

/** Names the site cannot serve as a link, whatever the registry says.
 *
 * The app routes are all hash fragments, so `#/create` and a name `create`
 * never collide. What does collide is anything the edge answers before the app
 * sees it: files served from disk. Claiming one of these on chain is allowed
 * and simply produces a link this site will not route, which is why the check
 * is here and not in the contract.
 *
 * `/v0` is reverse proxied (docker/Caddyfile:7) and is deliberately NOT in this
 * list: it is two characters, so the length rule already refuses it, and an
 * entry that can never be reached is a rule that looks enforced and is not.
 * Every entry below is long enough to be a real name.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'api', 'assets', 'static', 'public',
  'index', 'favicon', 'robots', 'sitemap', 'manifest',
]);

/** Lowercase and trim. The contract refuses anything not already lowercase, so
 * this is what a caller has to run first. */
export function normalizeName(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Why `name` cannot be used, or null when it can.
 *
 * The message is written to be shown to the person who typed it, so it names
 * the fix rather than the rule that was broken.
 */
export function nameProblem(name: string): string | null {
  if (!name) return 'pick a name for the link';
  if (name !== normalizeName(name)) return 'lowercase only';
  if (name.length < MIN_NAME_CHARS) return `at least ${MIN_NAME_CHARS} characters`;
  if (name.length > MAX_NAME_CHARS) return `at most ${MAX_NAME_CHARS} characters`;
  if (name.startsWith('-') || name.endsWith('-')) return 'cannot start or end with a hyphen';
  if (!/^[a-z0-9-]+$/.test(name)) return 'letters, numbers and hyphens only';
  if (RESERVED_NAMES.has(name)) return 'that one is reserved, try another';
  return null;
}

export function isValidName(name: string): boolean {
  return nameProblem(name) === null;
}

/** The link a claimed name produces. A path, not a fragment: the edge already
 * serves the app for any path (docker/Caddyfile:14), so this needs no server
 * change and no redirect. */
export function nameLink(base: { origin: string }, name: string): string {
  return `${base.origin}/${name}`;
}
