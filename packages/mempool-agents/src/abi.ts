// Minimal ABIs for the encrypted-mempool contracts, hand-written to match
// contracts/src/*.sol. Only the pieces the agents actually touch.

export const erc20Abi = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export const demoTokenAbi = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'who', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export const swapPoolAbi = [
  { type: 'function', name: 'reserveBase', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'reserveQuote', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sync', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'adminSetReserves', stateMutability: 'nonpayable',
    inputs: [{ name: 'baseTarget', type: 'uint256' }, { name: 'quoteTarget', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getAmountOut', stateMutability: 'pure',
    inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'reserveIn', type: 'uint256' }, { name: 'reserveOut', type: 'uint256' }],
    outputs: [{ type: 'uint256' }] },
] as const;

export const publicBuilderAbi = [
  { type: 'function', name: 'submitOrder', stateMutability: 'nonpayable',
    inputs: [{ name: 'order', type: 'tuple', components: [
      { name: 'trader', type: 'address' }, { name: 'baseToQuote', type: 'bool' },
      { name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' }, { name: 'to', type: 'address' },
    ] }],
    outputs: [{ name: 'id', type: 'bytes32' }] },
  { type: 'function', name: 'execute', stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sandwich', stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }, { name: 'frontAmountIn', type: 'uint256' }],
    outputs: [{ name: 'victimOut', type: 'uint256' }, { name: 'searcherProfit', type: 'uint256' }] },
  { type: 'function', name: 'executed', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  // The public `pending` mapping's getter. A zero trader means the builder has
  // never seen this id, which is how the relayer tells "no such order" apart
  // from "submitted and still waiting for a builder".
  { type: 'function', name: 'pending', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'trader', type: 'address' }, { name: 'baseToQuote', type: 'bool' },
      { name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' },
      { name: 'to', type: 'address' },
    ] },
  { type: 'event', name: 'Pending', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'trader', type: 'address', indexed: true },
    { name: 'baseToQuote', type: 'bool', indexed: false }, { name: 'amountIn', type: 'uint256', indexed: false },
    { name: 'minOut', type: 'uint256', indexed: false } ] },
  { type: 'event', name: 'Sandwiched', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'victimOut', type: 'uint256', indexed: false },
    { name: 'searcherProfit', type: 'uint256', indexed: false } ] },
  { type: 'event', name: 'Executed', inputs: [
    { name: 'id', type: 'bytes32', indexed: true }, { name: 'amountOut', type: 'uint256', indexed: false } ] },
] as const;

export const pealMempoolAbi = [
  { type: 'function', name: 'commitSealed', stateMutability: 'nonpayable',
    inputs: [{ name: 'conditionId', type: 'bytes32' }, { name: 'ctHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'executeBatch', stateMutability: 'nonpayable',
    inputs: [
      { name: 'conditionId', type: 'bytes32' },
      { name: 'slots', type: 'tuple[]', components: [
        { name: 'position', type: 'uint32' }, { name: 'isReal', type: 'bool' }, { name: 'payload', type: 'bytes' } ] },
      { name: 'merkleRoot', type: 'bytes32' } ],
    outputs: [] },
  { type: 'function', name: 'computeRoot', stateMutability: 'pure',
    inputs: [{ name: 'slots', type: 'tuple[]', components: [
      { name: 'position', type: 'uint32' }, { name: 'isReal', type: 'bool' }, { name: 'payload', type: 'bytes' } ] }],
    outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'settledRoot', stateMutability: 'view',
    inputs: [{ name: 'conditionId', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  { type: 'event', name: 'Sealed', inputs: [
    { name: 'conditionId', type: 'bytes32', indexed: true }, { name: 'ctHash', type: 'bytes32', indexed: true },
    { name: 'from', type: 'address', indexed: true } ] },
  { type: 'event', name: 'BatchExecuted', inputs: [
    { name: 'conditionId', type: 'bytes32', indexed: true }, { name: 'merkleRoot', type: 'bytes32', indexed: false },
    { name: 'realCount', type: 'uint256', indexed: false } ] },
  { type: 'event', name: 'OrderFilled', inputs: [
    { name: 'conditionId', type: 'bytes32', indexed: true }, { name: 'position', type: 'uint32', indexed: false },
    { name: 'amountOut', type: 'uint256', indexed: false } ] },
] as const;
