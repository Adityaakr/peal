import { describe, expect, it } from 'vitest';
import {
  MAX_NAME_CHARS, MIN_NAME_CHARS, RESERVED_NAMES, isValidName, nameLink, nameProblem, normalizeName,
} from '../src/name.js';

describe('link names', () => {
  it.each(['shoonya', 'abc', 'shoonya-live', 'drop-2', 'a1b2c3', 'x'.repeat(MAX_NAME_CHARS)])(
    'accepts %s', (name) => expect(nameProblem(name)).toBeNull(),
  );

  it.each([
    ['', 'pick a name for the link'],
    ['ab', `at least ${MIN_NAME_CHARS} characters`],
    ['x'.repeat(MAX_NAME_CHARS + 1), `at most ${MAX_NAME_CHARS} characters`],
    ['-shoonya', 'cannot start or end with a hyphen'],
    ['shoonya-', 'cannot start or end with a hyphen'],
    ['Shoonya', 'lowercase only'],
    ['shoonya!', 'letters, numbers and hyphens only'],
    ['shoo nya', 'letters, numbers and hyphens only'],
    ['shoonya.eth', 'letters, numbers and hyphens only'],
    ['shoo_nya', 'letters, numbers and hyphens only'],
    ['shoonyaé', 'letters, numbers and hyphens only'],
    ['assets', 'that one is reserved, try another'],
  ])('refuses %j with %j', (name, why) => {
    expect(nameProblem(name)).toBe(why);
    expect(isValidName(name)).toBe(false);
  });

  it('reserves only what the edge answers before the app sees it', () => {
    // The app's own routes are hash fragments, so a name never collides with
    // one. Only files on disk do.
    expect(RESERVED_NAMES.has('assets')).toBe(true);
    expect(RESERVED_NAMES.has('create')).toBe(false);
    expect(RESERVED_NAMES.has('live')).toBe(false);
  });

  it('has no reserved name that the length rule already refuses', () => {
    // `v0` used to be in this list and was unreachable: it is two characters,
    // so it never got as far as the reserved check. A rule that looks enforced
    // and is not is worse than no rule.
    for (const name of RESERVED_NAMES) {
      expect(nameProblem(name)).toBe('that one is reserved, try another');
    }
  });

  it('lowercases and trims', () => {
    expect(normalizeName('  Shoonya  ')).toBe('shoonya');
    expect(nameProblem(normalizeName('  Shoonya  '))).toBeNull();
  });

  it('builds a path link, not a fragment', () => {
    expect(nameLink({ origin: 'https://peal.network' }, 'shoonya')).toBe('https://peal.network/shoonya');
  });
});
