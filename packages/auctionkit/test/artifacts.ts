/** Read bytecode straight from the forge artifacts.
 *
 * The e2e test deploys the same bytecode `forge build` produces, so it exercises
 * the real contracts rather than a fixture that could drift from them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'contracts', 'out');

export function bytecodeOf(file: string, name: string): Hex {
  const a = JSON.parse(readFileSync(join(out, file, `${name}.json`), 'utf8'));
  return a.bytecode.object as Hex;
}

/** EIP-1167 minimal proxy.
 *
 * SealedBidAuction's constructor calls `_disableInitializers()`, so a directly
 * deployed instance can never be initialised — only a clone of it can. That is
 * the safety property, and it means the test has to clone too.
 */
export function minimalProxy(implementation: Hex): Hex {
  const impl = implementation.slice(2).toLowerCase();
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`;
}
