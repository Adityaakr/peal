import { describe, expect, it } from 'vitest';
import {
  MAX_DESCRIPTION_CHARS, MAX_IMAGE_CHARS, TermsError, canonicalTerms, checksum, imageProblem, liveLink, packTerms,
  registryProblem, unpackTerms, type Terms,
} from '../src/terms.js';

const BASE: Terms = {
  auctionId: 'cond_220d820315fb9ef12f73c8fb',
  title: 'signed tour poster',
  unit: 'USD',
  decimals: 2,
  closeAt: 1_788_400_000,
  reserveMinor: 2500,
  maxMinor: null,
  image: null,
  description: null,
  contactKey: null,
};

describe('auction terms', () => {
  it('round trips through a link fragment', () => {
    expect(unpackTerms(packTerms(BASE))).toEqual(BASE);
  });

  it('round trips with no reserve', () => {
    const t = { ...BASE, reserveMinor: null };
    expect(unpackTerms(packTerms(t))).toEqual(t);
  });

  it('survives a title with characters that need escaping', () => {
    const t = { ...BASE, title: 'a "rare" poster / 1 of 3 and a 🎈' };
    expect(unpackTerms(packTerms(t))?.title).toBe(t.title);
  });

  it('serialises the same bytes however the object was built', () => {
    const reordered: Terms = {
      contactKey: BASE.contactKey, description: BASE.description, image: BASE.image,
      maxMinor: BASE.maxMinor,
      reserveMinor: BASE.reserveMinor,
      closeAt: BASE.closeAt, decimals: BASE.decimals, unit: BASE.unit, title: BASE.title,
      auctionId: BASE.auctionId,
    };
    expect(canonicalTerms(reordered)).toEqual(canonicalTerms(BASE));
  });

  it('trims the title before committing to it, so the checksum is not whitespace sensitive', async () => {
    expect(await checksum({ ...BASE, title: `  ${BASE.title}  ` })).toBe(await checksum(BASE));
  });

  it.each([
    ['an empty title', { title: '   ' }],
    ['a title past the cap', { title: 'x'.repeat(81) }],
    ['an empty unit', { unit: '' }],
    ['fractional decimals', { decimals: 1.5 }],
    ['more decimals than the format allows', { decimals: 5 }],
    ['a close time that is not an integer', { closeAt: 1.5 }],
    ['a fractional reserve', { reserveMinor: 10.5 }],
  ])('refuses %s', (_label, patch) => {
    expect(() => packTerms({ ...BASE, ...patch } as Terms)).toThrow(TermsError);
  });

  it.each([
    ['not base64', '!!!!'],
    ['not json', packTerms(BASE).slice(0, 8)],
    ['an object rather than the tuple', btoa('{"a":1}').replace(/=+$/, '')],
    ['a tuple of the wrong length', btoa('[5,1,2,3]').replace(/=+$/, '')],
    ['a future version', btoa(JSON.stringify([6, 'c', 't', 'USD', 2, 1, null, null, null, null, null])).replace(/=+$/, '')],
    ['terms that fail validation', btoa(JSON.stringify([5, 'c', '', 'USD', 2, 1, null, null, null, null, null])).replace(/=+$/, '')],
  ])('returns null for %s rather than throwing', (_label, packed) => {
    expect(unpackTerms(packed)).toBeNull();
  });

  describe('the spoken checksum', () => {
    it('is eight characters in two groups', async () => {
      expect(await checksum(BASE)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
    });

    it('never contains a character that can be misheard', async () => {
      const many = await Promise.all(
        Array.from({ length: 200 }, (_, i) => checksum({ ...BASE, closeAt: BASE.closeAt + i })),
      );
      expect(many.join('')).not.toMatch(/[ILOU]/);
    });

    it('is stable for the same terms', async () => {
      expect(await checksum(BASE)).toBe(await checksum({ ...BASE }));
    });

    it.each([
      ['the reserve', { reserveMinor: 2501 }],
      ['the close time', { closeAt: BASE.closeAt + 1 }],
      ['the title', { title: 'a different poster' }],
      ['the auction', { auctionId: 'cond_000000000000000000000000' }],
    ])('changes when %s changes, which is the whole point', async (_label, patch) => {
      expect(await checksum({ ...BASE, ...patch })).not.toBe(await checksum(BASE));
    });
  });

  it('builds a share link that carries nothing but the terms', () => {
    const url = liveLink({ origin: 'https://peal.network', pathname: '/' }, BASE);
    expect(url).toBe(`https://peal.network/#/live/${packTerms(BASE)}`);
    // Everything identifying is behind the hash, so opening a link tells no
    // server which auction was opened.
    expect(url.split('#')[0]).toBe('https://peal.network/');
  });
});

describe('the terms hash that goes on chain', () => {
  it('is 32 bytes of hex', async () => {
    const { termsHash } = await import('../src/terms.js');
    expect(await termsHash(BASE)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('commits to every field', async () => {
    const { termsHash } = await import('../src/terms.js');
    const base = await termsHash(BASE);
    for (const patch of [
      { title: 'other' }, { unit: 'EUR' }, { decimals: 0 },
      { closeAt: BASE.closeAt + 1 }, { reserveMinor: null }, { auctionId: 'cond_x' },
    ]) {
      expect(await termsHash({ ...BASE, ...patch } as Terms)).not.toBe(base);
    }
  });
});

describe('one link, one checksum', () => {
  // Same encoding packTerms uses: utf-8 bytes first, then base64url. btoa on
  // the string directly cannot carry anything outside latin-1.
  const packRaw = (wire: unknown[]): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(wire));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // canonicalTerms trims before hashing. While unpackTerms handed back the
  // untrimmed strings, a forger could pad a title with whitespace and get a
  // link that rendered differently but produced the SAME spoken checksum and
  // the SAME on-chain terms hash, which is precisely the swap the checksum is
  // supposed to catch.
  it.each([
    ['newlines', '\n'.repeat(20)],
    ['spaces', '   '],
    ['a no-break space', ' '],
    ['a line separator', ' '],
    ['a byte order mark', '﻿'],
    ['an ideographic space', '　'],
  ])('refuses a link whose title is padded with %s', (_label, pad) => {
    const forged = packRaw([5, BASE.auctionId, `${pad}${BASE.title}${pad}`, BASE.unit,
      BASE.decimals, BASE.closeAt, BASE.reserveMinor, BASE.maxMinor, BASE.image,
      BASE.description, BASE.contactKey]);
    expect(forged).not.toBe(packTerms(BASE));
    expect(unpackTerms(forged)).toBeNull();
  });

  it('refuses a link whose unit is padded', () => {
    const forged = packRaw([5, BASE.auctionId, BASE.title, ' USD ', BASE.decimals,
      BASE.closeAt, BASE.reserveMinor, BASE.maxMinor, BASE.image]);
    expect(unpackTerms(forged)).toBeNull();
  });

  it('re-packs to exactly the link it came from', () => {
    const packed = packTerms(BASE);
    expect(packTerms(unpackTerms(packed)!)).toBe(packed);
  });

  it('refuses a link that re-serialises to different bytes', () => {
    // 1e3 is a number JSON.parse accepts and JSON.stringify writes back as 1000,
    // so the link is not one packTerms could have produced.
    expect(unpackTerms(packRaw([5, BASE.auctionId, BASE.title, BASE.unit, 2, 1e3, null, null, null, null, null])))
      .not.toBeNull();
    expect(unpackTerms(btoa('[5,"cond_x","t","USD",2,1e3,null,null,null,null,null]').replace(/=+$/, ''))).toBeNull();
  });
});

describe('bounds', () => {
  it('refuses an auction id long enough to make the link a payload', () => {
    expect(() => packTerms({ ...BASE, auctionId: 'x'.repeat(65) })).toThrow(TermsError);
  });

  it('counts the title in characters people would count, not utf-16 units', () => {
    // 80 emoji is 160 UTF-16 units and used to be rejected; 80 CJK characters
    // is 80 units and was accepted. Both are 80 characters.
    expect(() => packTerms({ ...BASE, title: '🎈'.repeat(80) })).not.toThrow();
    expect(() => packTerms({ ...BASE, title: '🎈'.repeat(81) })).toThrow(TermsError);
  });
});

describe('the reserve', () => {
  it('refuses a reserve no bid could ever meet', async () => {
    const { MAX_AMOUNT_MINOR } = await import('../src/record.js');
    expect(() => packTerms({ ...BASE, reserveMinor: MAX_AMOUNT_MINOR })).not.toThrow();
    expect(() => packTerms({ ...BASE, reserveMinor: MAX_AMOUNT_MINOR + 1 })).toThrow(TermsError);
    // Number.isInteger(1e21) is true, which is how this rendered on screen as
    // the string "1e+21".
    expect(() => packTerms({ ...BASE, reserveMinor: 1e21 })).toThrow(TermsError);
  });
});


describe('the bid ceiling', () => {
  it('round trips', () => {
    const t = { ...BASE, maxMinor: 50_000 };
    expect(unpackTerms(packTerms(t))?.maxMinor).toBe(50_000);
  });

  it.each([
    ['a fractional maximum', { maxMinor: 10.5 }],
    ['a zero maximum', { maxMinor: 0 }],
    ['a maximum below the reserve', { reserveMinor: 5000, maxMinor: 4999 }],
  ])('refuses %s', (_label, patch) => {
    expect(() => packTerms({ ...BASE, ...patch } as Terms)).toThrow(TermsError);
  });

  it('allows a maximum equal to the reserve', () => {
    expect(() => packTerms({ ...BASE, reserveMinor: 5000, maxMinor: 5000 })).not.toThrow();
  });

  it('is part of the checksum, so a link cannot have its ceiling edited quietly', async () => {
    expect(await checksum({ ...BASE, maxMinor: 50_000 })).not.toBe(await checksum(BASE));
  });
});

describe('the wire version', () => {
  it('refuses an older link rather than filling in the field it lacks', () => {
    // The tuple is positional, so links of different lengths cannot be told
    // apart by shape. Reading an older one with a default filled in would be
    // honouring terms nobody agreed to.
    const older = btoa(JSON.stringify([4, BASE.auctionId, BASE.title, BASE.unit, 2, BASE.closeAt, null, null, null, null]))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(unpackTerms(older)).toBeNull();
  });
});

describe('the picture', () => {
  const IMG = 'https://images.example.com/poster.jpg';

  it('round trips', () => {
    expect(unpackTerms(packTerms({ ...BASE, image: IMG }))?.image).toBe(IMG);
  });

  it('is part of the checksum, so swapping it changes the code read on stream', async () => {
    expect(await checksum({ ...BASE, image: IMG })).not.toBe(await checksum(BASE));
    expect(await checksum({ ...BASE, image: `${IMG}?2` }))
      .not.toBe(await checksum({ ...BASE, image: IMG }));
  });

  it.each([
    ['javascript:alert(1)', 'the picture link has to start with https'],
    ['data:image/png;base64,AAAA', 'the picture link has to start with https'],
    ['http://images.example.com/a.jpg', 'the picture link has to start with https'],
    ['not a url at all', 'that picture link is not a web address'],
    ['ftp://example.com/a.jpg', 'the picture link has to start with https'],
  ])('refuses %s', (url, why) => {
    expect(imageProblem(url)).toBe(why);
    expect(() => packTerms({ ...BASE, image: url })).toThrow(TermsError);
  });

  it('refuses a link long enough to push the terms past what the registry takes', () => {
    const long = `https://e.com/${'a'.repeat(MAX_IMAGE_CHARS)}`;
    expect(imageProblem(long)).toMatch(/exceeds/);
    expect(() => packTerms({ ...BASE, image: long })).toThrow(TermsError);
  });

  it('leaves room for a short link on an ordinary auction', () => {
    expect(registryProblem({ ...BASE, image: IMG })).toBeNull();
    expect(registryProblem({ ...BASE, title: 'x'.repeat(80), image: `https://e.com/${'a'.repeat(150)}` }))
      .toBeNull();
  });

  it('says so before the auction exists when the terms are too big to name', () => {
    // PealNames refuses terms over 512 bytes and cannot be changed. Discovering
    // that from a reverted claim, on an auction that is already running and can
    // never be edited, is the worst possible moment.
    const huge: Terms = {
      auctionId: 'x'.repeat(64),
      title: '🎈'.repeat(80),
      unit: 'x'.repeat(12),
      decimals: 4,
      closeAt: 9_999_999_999,
      reserveMinor: 1_000_000_000_000,
      maxMinor: 1_000_000_000_000,
      image: `https://e.com/${'a'.repeat(MAX_IMAGE_CHARS - 15)}`,
      description: 'x'.repeat(MAX_DESCRIPTION_CHARS),
      contactKey: null,
    };
    // The auction itself is fine: the fragment has no such limit.
    expect(() => packTerms(huge)).not.toThrow();
    expect(registryProblem(huge)).toMatch(/fewer characters/);
  });

  it('treats an empty string as no picture rather than a broken one', () => {
    expect(imageProblem('')).toBeNull();
    expect(imageProblem('   ')).toBeNull();
  });
});


describe('the description', () => {
  const WORDS = 'Hand crocheted in Jaipur, one of a kind, ships worldwide.';

  it('round trips', () => {
    expect(unpackTerms(packTerms({ ...BASE, description: WORDS }))?.description).toBe(WORDS);
  });

  it('is part of the checksum, so the words cannot be edited quietly', async () => {
    expect(await checksum({ ...BASE, description: WORDS })).not.toBe(await checksum(BASE));
  });

  it('treats blank as none rather than as an empty paragraph', () => {
    expect(unpackTerms(packTerms({ ...BASE, description: '   ' }))?.description).toBeNull();
    expect(packTerms({ ...BASE, description: '' })).toBe(packTerms(BASE));
  });

  it('refuses one longer than the cap, counted in characters people count', () => {
    expect(() => packTerms({ ...BASE, description: '🎈'.repeat(MAX_DESCRIPTION_CHARS) })).not.toThrow();
    expect(() => packTerms({ ...BASE, description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1) }))
      .toThrow(TermsError);
  });

  it('leaves just enough room for a short link on its own', () => {
    // Measured: a bare set of terms is 127 bytes and a full length description
    // takes it to 498, against the registry's 512. The cap is set where it is
    // so that writing a paragraph does not by itself cost you a short link.
    expect(registryProblem({ ...BASE, description: 'x'.repeat(MAX_DESCRIPTION_CHARS) })).toBeNull();
    expect(registryProblem({ ...BASE, description: WORDS })).toBeNull();
  });

  it('says so when a description AND a picture link together do not fit', () => {
    expect(registryProblem({
      ...BASE,
      description: 'x'.repeat(MAX_DESCRIPTION_CHARS),
      image: `https://e.com/${'a'.repeat(186)}`,
    })).toMatch(/fewer characters/);
  });
});

describe('the seller key in the terms', () => {
  it('accepts a real one and refuses anything else', async () => {
    const { generateSellerKeys } = await import('../src/contact.js');
    const keys = await generateSellerKeys();
    expect(unpackTerms(packTerms({ ...BASE, contactKey: keys.publicKey }))?.contactKey)
      .toBe(keys.publicKey);

    // It arrives inside a link a stranger sent, and it is what bidders encrypt
    // to. A malformed one would mean contact details nobody can ever open.
    for (const bad of ['', 'nope', 'x'.repeat(88), 'a'.repeat(200)]) {
      expect(() => packTerms({ ...BASE, contactKey: bad })).toThrow(TermsError);
    }
  });

  it('is covered by the checksum, so it cannot be swapped for one of yours', async () => {
    const { generateSellerKeys } = await import('../src/contact.js');
    const a = await generateSellerKeys();
    const b = await generateSellerKeys();
    expect(await checksum({ ...BASE, contactKey: a.publicKey }))
      .not.toBe(await checksum({ ...BASE, contactKey: b.publicKey }));
    expect(await checksum({ ...BASE, contactKey: a.publicKey })).not.toBe(await checksum(BASE));
  });

  it('leaves room for a short link, and says so when it does not', async () => {
    const { generateSellerKeys } = await import('../src/contact.js');
    const keys = await generateSellerKeys();
    expect(registryProblem({ ...BASE, contactKey: keys.publicKey })).toBeNull();
    // A key is about ninety characters, so it and a full description together
    // are what tips an ordinary auction over the registry's limit.
    expect(registryProblem({
      ...BASE,
      contactKey: keys.publicKey,
      description: 'x'.repeat(MAX_DESCRIPTION_CHARS),
    })).toMatch(/fewer characters/);
  });
});

describe('what the short-link message asks for', () => {
  const tooBig: Terms = {
    ...BASE,
    description: 'x'.repeat(MAX_DESCRIPTION_CHARS),
    image: `https://cdn.example.com/${'a'.repeat(170)}`,
  };

  it('counts characters, not the base64 they turn into', () => {
    // The packed form is four thirds of what it encodes. Reporting the packed
    // overshoot said 248 when 186 characters would have done it, so a seller
    // was told to cut a third more than they had to.
    const said = Number(/about (\d+) fewer/.exec(registryProblem(tooBig)!)![1]);

    let cut = 0;
    let t = tooBig;
    while (registryProblem(t) !== null && cut < 500) {
      cut++;
      t = { ...tooBig, description: 'x'.repeat(Math.max(0, MAX_DESCRIPTION_CHARS - cut)) };
    }
    // Within a few characters of the truth, and never asking for more than it
    // needs by a wide margin.
    expect(said).toBeGreaterThanOrEqual(cut - 8);
    expect(said).toBeLessThanOrEqual(cut + 8);
  });

  it('names the longest field, so it is an instruction rather than a hint', () => {
    expect(registryProblem(tooBig)).toContain('the description is the longest');
    // Still over the cap, but now the picture link is the longer of the two.
    const pictureHeavy: Terms = {
      ...BASE,
      description: 'x'.repeat(150),
      image: `https://cdn.example.com/${'a'.repeat(MAX_IMAGE_CHARS - 24)}`,
    };
    expect(registryProblem(pictureHeavy)).toContain('the picture link is the longest');
  });

  it('mentions the contact key only when one is costing you the room', async () => {
    const { generateSellerKeys } = await import('../src/contact.js');
    const keys = await generateSellerKeys();
    expect(registryProblem(tooBig)).not.toContain('contact details');
    expect(registryProblem({ ...tooBig, contactKey: keys.publicKey }))
      .toContain('turning off contact details');
  });
});
