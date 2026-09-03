import { describe, expect, it } from 'vitest';
import {
  MAX_DESCRIPTION_CHARS, MAX_IMAGE_CHARS, MAX_TITLE_CHARS, canonicalTerms, packTerms, type Terms,
} from '../src/terms.js';
import {
  MAX_REGISTRY_BYTES, fromRegistryBytes, shortLinkProblem, toRegistryBytes,
} from '../src/registry.js';

const BASE: Terms = {
  auctionId: 'cond_220d820315fb9ef12f73c8fb',
  title: 'Put Your Logo on PolyBaskets — Nepal Relief',
  unit: 'USD', decimals: 2, closeAt: 1_788_000_000, reserveMinor: null, maxMinor: null,
  image: 'https://pbs.twimg.com/media/HRSgPmSakAIlIEW?format=jpg&name=medium',
  description:
    '7 spots on the PolyBaskets logo are open for Nepal relief. Add your preferred spot + X/TG handle when bidding (e.g. Project #2 · @handle). Highest bid per spot wins. Winners can pay us or donate at https://pmdrf.nchl.com.np/ and share the receipt. Logos stay live for 7 days',
  contactKey: null,
};

/** Text that deflate cannot help with, generated the same way every run.
 *
 * The cap can only be exceeded by content that does not compress, so a test
 * that wants to see a refusal has to produce some. Seeded rather than random,
 * because a test that only sometimes reaches the case it is named after is not
 * testing that case. */
function incompressible(count: number, seed: number, cjk = true): string {
  let out = '';
  let x = seed * 7919 + 987_654_321;
  for (let i = 0; i < count; i++) {
    x = (x * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    out += cjk
      ? String.fromCharCode(0x4e00 + (x % 20_000))
      : 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[x % 62];
  }
  return out;
}

describe('terms under a short name', () => {
  it('round trips', async () => {
    expect(await fromRegistryBytes(await toRegistryBytes(BASE))).toEqual(BASE);
  });

  it('is smaller than the terms it holds', async () => {
    const raw = canonicalTerms(BASE).length;
    const stored = (await toRegistryBytes(BASE)).length;
    expect(stored).toBeLessThan(raw);
  });

  it('fits a real auction that did not fit before', async () => {
    // 549 bytes uncompressed with contact details on, against a 512 cap, and
    // it was refused for 37. This is the case that prompted the change.
    const { generateSellerKeys } = await import('../src/contact.js');
    const keys = await generateSellerKeys();
    const withContact: Terms = { ...BASE, contactKey: keys.publicKey };
    expect(canonicalTerms(withContact).length).toBeGreaterThan(MAX_REGISTRY_BYTES);
    expect((await toRegistryBytes(withContact)).length).toBeLessThanOrEqual(MAX_REGISTRY_BYTES);
    expect(await shortLinkProblem(withContact)).toBeNull();
  });

  it('fits every field at its maximum, filled with real prose', async () => {
    const { generateSellerKeys } = await import('../src/contact.js');
    const keys = await generateSellerKeys();
    const prose = ('Hand crocheted in Jaipur by a family workshop, one of a kind, and it ships '
      + 'worldwide within three days of the auction closing. Ask before you bid if you want it '
      + 'in another colour, because we can usually make that happen for you quickly enough.')
      .slice(0, 280);
    expect(await shortLinkProblem({
      ...BASE,
      title: 'Put Your Logo on PolyBaskets and support Nepal Relief now',
      description: prose,
      contactKey: keys.publicKey,
    })).toBeNull();
  });

  it('still refuses something that genuinely cannot fit', async () => {
    const t = { ...BASE, description: incompressible(MAX_DESCRIPTION_CHARS, 3) };
    expect((await toRegistryBytes(t)).length).toBeGreaterThan(MAX_REGISTRY_BYTES);
    expect(await shortLinkProblem(t)).toMatch(/fewer characters/);
  });

  it('reads back an entry stored before compression', async () => {
    // The canonical bytes, which is what names claimed earlier hold.
    expect(await fromRegistryBytes(canonicalTerms(BASE))).toEqual(BASE);
  });

  it('reads back an entry stored before that, as base64 text', async () => {
    // The oldest shape: the base64 TEXT, which spent a third of the budget on
    // the encoding. Those names still resolve.
    const text = packTerms(BASE);
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    expect(await fromRegistryBytes(bytes)).toEqual(BASE);
  });

  it('refuses junk rather than resolving to a half-formed auction', async () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3, 4]),
      Uint8Array.from('not terms at all', (c) => c.charCodeAt(0)),
      Uint8Array.from([1, ...Array.from('nonsense', (c) => c.charCodeAt(0))]),
    ]) {
      expect(await fromRegistryBytes(bytes)).toBeNull();
    }
  });

  it('names the field to shorten, so it is an instruction rather than a hint', async () => {
    // Almost always the description or the picture link, and a seller looking
    // at three inputs should not have to guess which one is the problem.
    expect(await shortLinkProblem({ ...BASE, description: incompressible(MAX_DESCRIPTION_CHARS, 3) }))
      .toContain('in the description');

    // Same overflow, but now the item name is the longer of the two.
    expect(await shortLinkProblem({
      ...BASE,
      title: incompressible(MAX_TITLE_CHARS, 5),
      description: incompressible(60, 7),
      image: `https://cdn.example.com/${incompressible(MAX_IMAGE_CHARS - 24, 9, false)}`,
    })).toMatch(/in the item name|picture link/);
  });

  it('asks for a number of characters that actually clears the cap', async () => {
    // The number used to be the byte overshoot, which is not the same thing
    // once the terms are deflated: prose compresses, so being 38 bytes over
    // took far more than 38 characters and a seller was sent round the loop
    // again. It is searched now, through the function that does the storing.
    const t = { ...BASE, description: incompressible(MAX_DESCRIPTION_CHARS, 3) };
    const said = Number(/about (\d+) fewer/.exec((await shortLinkProblem(t))!)![1]);

    const kept = t.description.slice(0, t.description.length - said);
    expect(await shortLinkProblem({ ...t, description: kept })).toBeNull();
    // And not wildly more than it needs: one character back is still too big.
    expect(await shortLinkProblem({
      ...t, description: t.description.slice(0, kept.length + 1),
    })).not.toBeNull();
  });

  it('cannot be trimmed out of a picture link, so it says so', async () => {
    // Taking characters off the end of an address does not give a shorter
    // link, it gives a broken one.
    const problem = await shortLinkProblem({
      ...BASE,
      description: incompressible(120, 7),
      image: `https://cdn.example.com/${incompressible(MAX_IMAGE_CHARS - 24, 9, false)}`,
    });
    expect(problem).toContain('the picture link is the longest');
    expect(problem).toContain('use a shorter one');
  });

  it('mentions the contact key only when turning it off would be enough', async () => {
    const { generateSellerKeys } = await import('../src/contact.js');
    const keys = await generateSellerKeys();

    // Just over, and the key is the cheapest thing to give up.
    const marginal = {
      ...BASE,
      contactKey: keys.publicKey,
      description: incompressible(MAX_DESCRIPTION_CHARS, 11, false),
      image: `https://cdn.example.com/${incompressible(160, 13, false)}`,
    };
    expect(await shortLinkProblem(marginal)).toContain('turning off contact details');

    // Far over: dropping the key would not save it, so promising that it would
    // is worse than not mentioning it.
    expect(await shortLinkProblem({
      ...marginal, description: incompressible(MAX_DESCRIPTION_CHARS, 3),
    })).not.toContain('contact details');
  });
});
