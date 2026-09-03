import { describe, expect, it } from 'vitest';
import { PADDING_MARKER, buildBoard, type RevealedSlot } from '../src/board.js';
import { encodeBid } from '../src/record.js';
import type { Terms } from '../src/terms.js';

const TERMS: Terms = {
  auctionId: 'cond_220d820315fb9ef12f73c8fb',
  title: 'signed tour poster',
  unit: 'USD',
  decimals: 2,
  closeAt: 1_788_400_000,
  reserveMinor: null,
  maxMinor: null,
  image: null,
  description: null,
  contactKey: null,
};

const b64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

function bidSlot(
  position: number,
  amountMinor: number,
  name: string,
  over: Partial<RevealedSlot> & { auctionId?: string } = {},
): RevealedSlot {
  const { auctionId = TERMS.auctionId, ...rest } = over;
  return {
    position,
    ct_hash: `hash${position}`,
    payload_b64: b64(encodeBid({ auctionId, amountMinor, name })),
    ...rest,
  };
}

function paddingSlot(position: number, over: Partial<RevealedSlot> = {}): RevealedSlot {
  const body = new TextEncoder().encode(`${PADDING_MARKER}0123456789abcdef`);
  return { position, ct_hash: `pad${position}`, payload_b64: b64(body), is_dummy: true, ...over };
}

describe('building the board from a reveal', () => {
  it('ranks bids high to low and names the winner', () => {
    const board = buildBoard(
      [bidSlot(0, 500, 'ana'), bidSlot(1, 12_00, 'bo'), bidSlot(2, 300, 'cy')],
      TERMS,
    );
    expect(board.bids.map((b) => b.name)).toEqual(['bo', 'ana', 'cy']);
    expect(board.winner?.name).toBe('bo');
    expect(board.winner?.amountMinor).toBe(1200);
  });

  it('breaks a tie on batch position, not on arrival', () => {
    // Positions come from sorting the real ciphertexts by ct_hash at freeze, so
    // they are a function of the ciphertext set and the host cannot steer them.
    const board = buildBoard([bidSlot(3, 700, 'late'), bidSlot(1, 700, 'early')], TERMS);
    expect(board.bids.map((b) => b.name)).toEqual(['early', 'late']);
    expect(board.winner?.name).toBe('early');
  });

  it('drops the coordinator padding without counting it as a bid', () => {
    const board = buildBoard([paddingSlot(0), bidSlot(1, 900, 'ana'), paddingSlot(2)], TERMS);
    expect(board.padding).toBe(2);
    expect(board.bids).toHaveLength(1);
    expect(board.discarded).toHaveLength(0);
  });

  it('identifies padding from the sealed bytes, not from the flag beside them', () => {
    // is_dummy is the coordinator's assertion. The marker is in the payload
    // that was actually sealed, so it is the one anybody can check.
    const lyingFlags = [
      paddingSlot(0, { is_dummy: false }),
      bidSlot(1, 900, 'ana', { is_dummy: true }),
    ];
    const board = buildBoard(lyingFlags, TERMS);
    expect(board.padding).toBe(1);
    expect(board.bids.map((b) => b.name)).toEqual(['ana']);
  });

  it('discards a bid replayed from another auction', () => {
    // A ciphertext is not bound to a condition, so a blob posted to one auction
    // can be reposted into another and will decrypt cleanly. The auction id
    // inside the sealed record is what catches it.
    const board = buildBoard(
      [bidSlot(0, 100, 'honest'), bidSlot(1, 999_00, 'replayed', { auctionId: 'cond_other' })],
      TERMS,
    );
    expect(board.bids.map((b) => b.name)).toEqual(['honest']);
    expect(board.winner?.name).toBe('honest');
    expect(board.discarded).toEqual([{ position: 1, ctHash: 'hash1', reason: 'other-auction' }]);
  });

  it('discards a payload it cannot read without losing the rest of the board', () => {
    const junk: RevealedSlot = { position: 1, ct_hash: 'hash1', payload_b64: b64(new Uint8Array(96)) };
    const board = buildBoard([bidSlot(0, 100, 'ana'), junk, bidSlot(2, 200, 'bo')], TERMS);
    expect(board.bids.map((b) => b.name)).toEqual(['bo', 'ana']);
    expect(board.discarded).toEqual([{ position: 1, ctHash: 'hash1', reason: 'unreadable' }]);
  });

  it('survives a payload that is not base64 at all', () => {
    const board = buildBoard(
      [{ position: 0, ct_hash: 'h', payload_b64: '!!!not base64!!!' }, bidSlot(1, 100, 'ana')],
      TERMS,
    );
    expect(board.bids.map((b) => b.name)).toEqual(['ana']);
    expect(board.discarded[0]?.reason).toBe('unreadable');
  });

  describe('with a reserve', () => {
    const reserved: Terms = { ...TERMS, reserveMinor: 1000 };

    it('still shows a bid under the reserve but will not let it win', () => {
      const board = buildBoard([bidSlot(0, 900, 'under'), bidSlot(1, 1500, 'over')], reserved);
      expect(board.bids.map((b) => b.name)).toEqual(['over', 'under']);
      expect(board.bids.find((b) => b.name === 'under')?.meetsReserve).toBe(false);
      expect(board.winner?.name).toBe('over');
    });

    it('has no winner when every bid is under the reserve', () => {
      const board = buildBoard([bidSlot(0, 900, 'under'), bidSlot(1, 100, 'lower')], reserved);
      expect(board.bids).toHaveLength(2);
      expect(board.winner).toBeNull();
    });

    it('counts a bid exactly on the reserve', () => {
      expect(buildBoard([bidSlot(0, 1000, 'exact')], reserved).winner?.name).toBe('exact');
    });
  });

  it('has no winner and no bids for an empty reveal', () => {
    expect(buildBoard([], TERMS)).toEqual({
      bids: [], queue: [], winner: null, padding: 0, discarded: [],
    });
  });

  it('has no winner when the batch was nothing but padding', () => {
    const board = buildBoard([paddingSlot(0), paddingSlot(1)], TERMS);
    expect(board.winner).toBeNull();
    expect(board.padding).toBe(2);
  });
});

describe('a coordinator that repeats itself', () => {
  it('counts one row per ciphertext', () => {
    // A ct hash is a content address. Two slots carrying the same one would be
    // one bid given two rows and two chances to win.
    const dup = bidSlot(0, 500, 'ana');
    const board = buildBoard(
      [dup, { ...dup, position: 5 }, bidSlot(2, 300, 'bo')],
      TERMS,
    );
    expect(board.bids.map((b) => b.name)).toEqual(['ana', 'bo']);
    expect(board.bids).toHaveLength(2);
  });
});


describe('a bid nobody intends to honour', () => {
  const capped: Terms = { ...TERMS, maxMinor: 200_00 };

  it('cannot win, and is still shown', () => {
    // The whole point of the ceiling. Without it this bid takes the auction and
    // the seller has nothing.
    const board = buildBoard(
      [bidSlot(0, 99_999_999_00, 'troll'), bidSlot(1, 150_00, 'ana'), bidSlot(2, 120_00, 'bo')],
      capped,
    );
    expect(board.winner?.name).toBe('ana');
    // Visible, not deleted: a disruptive bid is more useful on screen and out
    // of the running than quietly removed.
    expect(board.bids.map((b) => b.name)).toEqual(['troll', 'ana', 'bo']);
    expect(board.bids[0]?.withinCap).toBe(false);
    expect(board.queue.map((b) => b.name)).toEqual(['ana', 'bo']);
  });

  it('costs the seller one line, not the auction', () => {
    const board = buildBoard(
      [bidSlot(0, 500_00, 'troll1'), bidSlot(1, 400_00, 'troll2'), bidSlot(2, 90_00, 'real')],
      capped,
    );
    expect(board.queue.map((b) => b.name)).toEqual(['real']);
    expect(board.winner?.name).toBe('real');
  });

  it('counts a bid exactly on the ceiling', () => {
    expect(buildBoard([bidSlot(0, 200_00, 'exact')], capped).winner?.name).toBe('exact');
  });

  it('leaves the queue empty when every bid is over the ceiling', () => {
    const board = buildBoard([bidSlot(0, 900_00, 'a'), bidSlot(1, 800_00, 'b')], capped);
    expect(board.bids).toHaveLength(2);
    expect(board.queue).toEqual([]);
    expect(board.winner).toBeNull();
  });
});

describe('the queue', () => {
  it('is who to offer the item to, in order, when the first does not pay', () => {
    const reserved: Terms = { ...TERMS, reserveMinor: 100_00, maxMinor: 500_00 };
    const board = buildBoard(
      [
        bidSlot(0, 900_00, 'over cap'),
        bidSlot(1, 400_00, 'first'),
        bidSlot(2, 250_00, 'second'),
        bidSlot(3, 50_00, 'under reserve'),
      ],
      reserved,
    );
    expect(board.queue.map((b) => b.name)).toEqual(['first', 'second']);
    expect(board.winner?.name).toBe('first');
    // Everything is still on the board with a reason it is not in the queue.
    expect(board.bids).toHaveLength(4);
  });

  it('is empty for an auction with no bids', () => {
    expect(buildBoard([], TERMS).queue).toEqual([]);
  });
});
