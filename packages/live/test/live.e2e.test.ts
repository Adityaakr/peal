/** The library against the real network.
 *
 * Skipped unless PEAL_LIVE_E2E is set, because it seals to the live
 * coordinator, waits out a real cue, and takes about two minutes. The unit
 * tests prove the codecs; this proves the codecs are the ones the network
 * actually round trips, which is a different claim.
 *
 *   PEAL_LIVE_E2E=1 packages/live/node_modules/.bin/vitest run --root packages/live
 */
import { describe, expect, it } from 'vitest';
import { BteClient } from 'bte-sdk';
import { buildBoard, type RevealedSlot } from '../src/board.js';
import { generateSellerKeys, openContact, sealContact } from '../src/contact.js';
import { ctHashOf, sealedBytes } from '../src/ciphertext.js';
import { decodeBid, encodeBid, type BidOrigin } from '../src/record.js';
import { convertMinor, crossRate, type RateTable } from '../src/rates.js';
import type { Terms } from '../src/terms.js';

const COORDINATOR = process.env.PEAL_LIVE_URL ?? 'https://peal.network';
const run = process.env.PEAL_LIVE_E2E ? describe : describe.skip;

run('a whole auction, against the live coordinator', () => {
  it('seals every bid to the same number of bytes, then opens to the right winner', async () => {
    const client = new BteClient({ url: COORDINATOR });
    const closeAt = Math.floor(Date.now() / 1000) + 75;
    const auctionId = await client.condition({ at: closeAt, tag: 'live:auction' });

    // Everything the terms can carry, so the round trip covers the whole shape
    // rather than the fields that happened to exist first.
    const keys = await generateSellerKeys();
    const terms: Terms = {
      auctionId,
      title: 'signed tour poster',
      unit: 'USD',
      decimals: 2,
      closeAt,
      reserveMinor: 1000,
      maxMinor: 500_00,
      image: 'https://images.example.com/poster.jpg',
      description: 'Hand crocheted in Jaipur. One of a kind.',
      contactKey: keys.publicKey,
    };

    // A bidder in Kathmandu typing rupees into a dollar auction. What travels
    // is the converted figure; the rupees ride along for the board to show.
    const table: RateTable = {
      base: 'USD',
      rates: { USD: 1, NPR: 151.837523 },
      asOf: new Date().toISOString(),
    };
    const nprTyped = 20_000_00;
    const nprCommitted = convertMinor(nprTyped, 2, 2, crossRate(table, 'NPR', 'USD')!);
    const nprOrigin: BidOrigin = { code: 'NPR', amountMinor: nprTyped, decimals: 2 };

    const entered: { amountMinor: number; name: string; origin?: BidOrigin }[] = [
      { amountMinor: 500, name: 'under the reserve' },
      { amountMinor: 125_00, name: 'ana' },
      { amountMinor: 90_00, name: 'bo 🎈' },
      { amountMinor: 999_00, name: 'over the cap' },
      { amountMinor: nprCommitted, name: 'kiran', origin: nprOrigin },
    ];
    // 20,000 rupees is about 131 dollars, so this bid should take the auction
    // from ana. If that stops being true the assertions below say so.
    expect(nprCommitted).toBeGreaterThan(125_00);

    const sizes = new Set<number>();
    for (const bid of entered) {
      // Half the bids carry contact details. The sealed sizes must still all
      // match: a bid that grew when a contact was attached would say on the
      // wire that there was one.
      const contact = bid.amountMinor % 2 === 0
        ? await sealContact(keys.publicKey, `reach-${bid.amountMinor}@example.com`)
        : null;
      const { sealedB64, ctHash } = await client.seal(encodeBid({ auctionId, ...bid, contact }), auctionId);
      sizes.add(sealedB64.length);
      // The coordinator's hash is checkable, so check it. The browser is still
      // holding the ciphertext it made.
      expect(await ctHashOf(sealedBytes(sealedB64)!)).toBe(ctHash);
    }
    // The property the record format exists for: a ciphertext's length says
    // nothing about the amount inside it.
    expect([...sizes]).toHaveLength(1);

    // Nothing is readable while the auction is open.
    expect(await client.reveal(auctionId)).toBeNull();

    const reveal = await client.waitForReveal(auctionId, { timeoutMs: 240_000 });
    // The board takes the API's own slot shape, which is what the explorer
    // holds. The SDK has already decoded the payload, so re-encode it here.
    const slots = reveal.slots.map(
      (s): RevealedSlot => ({
        position: s.position,
        ct_hash: s.ctHash,
        payload_b64: btoa(String.fromCharCode(...s.payload)),
        is_dummy: s.isDummy,
      }),
    );

    const board = buildBoard(slots, terms);
    expect(board.bids.map((b) => b.name))
      .toEqual(['over the cap', 'kiran', 'ana', 'bo 🎈', 'under the reserve']);
    // The queue is only the bids the terms allow to win.
    expect(board.queue.map((b) => b.name)).toEqual(['kiran', 'ana', 'bo 🎈']);
    // Ranked on the converted figure, which is what was committed.
    expect(board.winner?.name).toBe('kiran');
    expect(board.winner?.amountMinor).toBe(nprCommitted);
    // And the board can still say what that bidder actually typed.
    expect(board.winner?.origin).toEqual(nprOrigin);
    // Everyone else bid in the auction's own currency and carries nothing.
    expect(board.bids.filter((b) => b.origin !== null)).toHaveLength(1);
    expect(board.discarded).toEqual([]);

    // And the contact details come back out, for the holder of the key and
    // nobody else. The stranger's key is the assertion that matters: every
    // other bidder holds exactly these bytes.
    const stranger = await generateSellerKeys();
    let opened = 0;
    for (const slot of slots) {
      const bytes = Uint8Array.from(atob(slot.payload_b64), (c) => c.charCodeAt(0));
      const bid = decodeBid(bytes);
      if (!bid?.contact) continue;
      expect(await openContact(keys.privateKey, bid.contact)).toMatch(/^reach-\d+@example\.com$/);
      expect(await openContact(stranger.privateKey, bid.contact)).toBeNull();
      opened++;
    }
    expect(opened).toBeGreaterThan(0);
    // B is 64, so the coordinator padded the rest of the batch itself.
    expect(board.padding).toBe(slots.length - entered.length);
  }, 300_000);
});
