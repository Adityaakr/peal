// SDK unit tests: wasm sealing against committed fixture params, and the
// REST client against a mocked coordinator.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BteClient, MAX_PAYLOAD_BYTES, condition, seal } from '../src/index.js';
import { b64ToBytes, bytesToB64, ensureWasm } from '../src/wasm.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const paramsBytes = new Uint8Array(readFileSync(join(fixturesDir, 'params.bin')));
/** v1 (transparent setup) fixture: n=3, t=2, dealt from a fixed seed by
 * crates/bte-crypto/examples/tbte_fixture.rs. */
const paramsV1Bytes = new Uint8Array(readFileSync(join(fixturesDir, 'params-v1.bin')));

describe('wasm sealing', () => {
  it('parses fixture params and reports committee info', async () => {
    const { Params } = await ensureWasm();
    const params = new Params(paramsBytes);
    const info = params.info() as any;
    expect(info).toMatchObject({ scheme: 'v0', n: 3, t: 2, b: 4 });
    expect(info.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(params.scheme()).toBe('v0');
  });

  it('parses v1 params and seals BTE1 ciphertexts bound to a condition', async () => {
    const { Params, ctHash } = await ensureWasm();
    const params = new Params(paramsV1Bytes);
    const info = params.info() as any;
    expect(info).toMatchObject({ scheme: 'v1', n: 3, t: 2, b: 4096 });
    expect(info.setup_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(params.scheme()).toBe('v1');
    const payload = new TextEncoder().encode('sealed bid: 42');
    const sealed = params.seal_for('cond_v1', payload);
    // magic "BTE1" + type 0x01
    expect(Array.from(sealed.slice(0, 5))).toEqual([0x42, 0x54, 0x45, 0x31, 0x01]);
    // framing(5) + 48 + 96 + 48 points + 32 context + 64 proof + len(4) + tag(16) = 313
    expect(sealed.length).toBe(313 + payload.length);
    expect(ctHash(sealed)).toMatch(/^[0-9a-f]{64}$/);
    expect(bytesToB64(params.seal_for('cond_v1', payload))).not.toBe(bytesToB64(sealed));
    // A v1 committee refuses the condition-less v0 call.
    expect(() => params.seal(payload)).toThrow(/seal_for/);
  });

  it('seals payloads into BTE_WIRE_V0 ciphertexts with 48-byte headers', async () => {
    const { Params, ctHash } = await ensureWasm();
    const params = new Params(paramsBytes);
    const payload = new TextEncoder().encode('sealed bid: 42');
    const sealed = params.seal(payload);
    // magic "BTE0" + type 0x01
    expect(Array.from(sealed.slice(0, 5))).toEqual([0x42, 0x54, 0x45, 0x30, 0x01]);
    // framing(5) + header(48) + key mask(16) + len(4) + payload
    expect(sealed.length).toBe(5 + 48 + 16 + 4 + payload.length);
    expect(ctHash(sealed)).toMatch(/^[0-9a-f]{64}$/);
    // Sealing is randomized: same payload, different ciphertext.
    expect(bytesToB64(params.seal(payload))).not.toBe(bytesToB64(sealed));
  });

  it('rejects payloads over the cap', async () => {
    const { Params } = await ensureWasm();
    const params = new Params(paramsBytes);
    expect(() => params.seal(new Uint8Array(MAX_PAYLOAD_BYTES + 1))).toThrow(/payload/);
  });

  it('rejects garbage params', async () => {
    const { Params } = await ensureWasm();
    expect(() => new Params(new Uint8Array([1, 2, 3]))).toThrow(/invalid params/);
  });
});

function mockCoordinator(scheme: 'v0' | 'v1' = 'v0') {
  const fixture = scheme === 'v1' ? paramsV1Bytes : paramsBytes;
  const digest = (() => {
    // The client cross-checks info.digest against params_digest, so serve the
    // real digest of the fixture params via wasm.
    return ensureWasm().then(({ Params }) => {
      const p = new Params(fixture);
      return (p.info() as any).digest as string;
    });
  })();

  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.endsWith('/v0/committees/default')) {
      return json({
        id: await digest,
        scheme,
        n: 3,
        t: 2,
        b: scheme === 'v1' ? 4096 : 4,
        params_b64: bytesToB64(fixture),
        params_digest: await digest,
      });
    }
    if (url.endsWith('/v0/conditions') && init?.method === 'POST') {
      return json({ id: 'cond_test', status: 'pending', fires_at: body.fires_at ?? 0 });
    }
    if (url.endsWith('/v0/ciphertexts')) {
      return json({ ct_hash: 'a'.repeat(64) });
    }
    if (url.includes('/v0/reveals/cond_pending')) {
      return json({ error: 'not revealed' }, 404);
    }
    if (url.includes('/v0/reveals/cond_test')) {
      return json({
        revealed_at: 1700000000,
        merkle_root: 'b'.repeat(64),
        slots: [
          {
            position: 0,
            ct_hash: 'c'.repeat(64),
            is_dummy: false,
            valid: true,
            payload_b64: bytesToB64(new TextEncoder().encode('hello reveal')),
          },
          {
            position: 1,
            ct_hash: 'd'.repeat(64),
            is_dummy: true,
            valid: true,
            payload_b64: bytesToB64(new TextEncoder().encode('BTE_DUMMY_V0:xxxx')),
          },
        ],
        shares: [
          { batch_id: 1, operator_id: 1, verified: true, submitted_at_ms: 1 },
          { batch_id: 1, operator_id: 2, verified: false, submitted_at_ms: 2 },
        ],
      });
    }
    return json({ error: `unmocked ${url}` }, 500);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('BteClient', () => {
  it('creates conditions, seals client-side, and decodes reveals', async () => {
    const { fetchImpl, calls } = mockCoordinator();
    const client = new BteClient({ url: 'http://mock', fetch: fetchImpl });

    const info = await client.committee();
    expect(info).toMatchObject({ n: 3, t: 2, b: 4 });

    const conditionId = await condition({ in: 60 }, client);
    expect(conditionId).toBe('cond_test');

    const { ctHash, sealedB64 } = await seal('my sealed bid', conditionId, client);
    expect(ctHash).toMatch(/^[0-9a-f]{64}$/);
    // What went over the wire is a real BTE0 ciphertext, not the plaintext.
    const posted = calls.find((c) => c.url.endsWith('/v0/ciphertexts'))!;
    expect(posted.body.sealed_blob_b64).toBe(sealedB64);
    const sealedBytes = b64ToBytes(sealedB64);
    expect(Array.from(sealedBytes.slice(0, 4))).toEqual([0x42, 0x54, 0x45, 0x30]);
    const plaintext = new TextEncoder().encode('my sealed bid');
    const asString = Array.from(sealedBytes).join(',');
    expect(asString.includes(Array.from(plaintext).join(','))).toBe(false);

    const reveal = await client.reveal(conditionId);
    expect(reveal).not.toBeNull();
    const real = reveal!.slots.filter((s) => !s.isDummy);
    expect(real).toHaveLength(1);
    expect(real[0].text).toBe('hello reveal');
    expect(reveal!.shares.filter((s) => !s.verified)).toHaveLength(1);
  });

  it('seals to a v1 committee with the condition as context', async () => {
    const { fetchImpl, calls } = mockCoordinator('v1');
    const client = new BteClient({ url: 'http://mock', fetch: fetchImpl });
    const info = await client.committee();
    expect(info).toMatchObject({ scheme: 'v1', n: 3, t: 2, b: 4096 });
    expect(info.setupDigest).toMatch(/^[0-9a-f]{64}$/);
    const { sealedB64 } = await client.seal('v1 bid', 'cond_test');
    const posted = calls.find((c) => c.url.endsWith('/v0/ciphertexts'))!;
    expect(posted.body.condition_id).toBe('cond_test');
    expect(Array.from(b64ToBytes(sealedB64).slice(0, 4))).toEqual([0x42, 0x54, 0x45, 0x31]);
  });

  it('refuses a coordinator whose scheme claim disagrees with its params', async () => {
    const { fetchImpl } = mockCoordinator('v0');
    const lying = (async (input: any, init?: any) => {
      const resp = await fetchImpl(input, init);
      if (String(input).endsWith('/v0/committees/default')) {
        const body = await resp.json();
        body.scheme = 'v1';
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      }
      return resp;
    }) as typeof fetch;
    const client = new BteClient({ url: 'http://mock', fetch: lying });
    await expect(client.committee()).rejects.toThrow(/scheme mismatch/);
  });

  it('returns null for unrevealed conditions', async () => {
    const { fetchImpl } = mockCoordinator();
    const client = new BteClient({ url: 'http://mock', fetch: fetchImpl });
    expect(await client.reveal('cond_pending')).toBeNull();
  });

  it('rejects oversized payloads before any network call', async () => {
    const { fetchImpl } = mockCoordinator();
    const client = new BteClient({ url: 'http://mock', fetch: fetchImpl });
    // Pinned to the constant, not a literal, so raising the cap cannot leave
    // this asserting a number the code no longer uses.
    await expect(
      client.seal(new Uint8Array(MAX_PAYLOAD_BYTES + 1), 'cond_test'),
    ).rejects.toThrow(/exceeds/);
    await expect(
      client.seal(new Uint8Array(MAX_PAYLOAD_BYTES), 'cond_test'),
    ).resolves.toBeTruthy();
  });
});
