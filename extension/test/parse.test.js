// Parser tests, runnable with plain node: `node extension/test/parse.test.js`
//
// The load-bearing one is the last group: a private seal's AES key must never
// survive parsing. Everything downstream (the background worker, the network,
// the cache) receives only what comes out of here.

const assert = require('node:assert');
const { parseSealLink, handleKey } = require('../src/parse.js');

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

const CODE = 'bPGLBTUVOZ0';
const KEY = '_LSMEs_XJswgbir5_kqQUw';
const COND = 'cond_d8ae9b3a8879c6ca0793e51a';
const CT = '37575e76729a1ed995e23001cd93d901609de899e4644f89f0be91e0f9cf8858';

console.log('\nrecognises the shapes we ship');
t('short public, hash route', () => {
  assert.deepStrictEqual(parseSealLink(`https://peal.network/#/s/${CODE}`), {
    kind: 'code',
    value: CODE,
  });
});
t('short private, hash route', () => {
  assert.deepStrictEqual(parseSealLink(`https://peal.network/#/s/${CODE}/${KEY}`), {
    kind: 'code',
    value: CODE,
  });
});
t('short public, real path (future OG route)', () => {
  assert.deepStrictEqual(parseSealLink(`https://peal.network/s/${CODE}`), {
    kind: 'code',
    value: CODE,
  });
});
t('long public, still shared in the wild', () => {
  assert.deepStrictEqual(parseSealLink(`https://peal.network/#/s/${COND}/${CT}`), {
    kind: 'condition',
    value: COND,
  });
});
t('long private', () => {
  assert.deepStrictEqual(parseSealLink(`https://peal.network/#/s/${COND}/${CT}/${KEY}`), {
    kind: 'condition',
    value: COND,
  });
});

console.log('\nhandles how X actually renders a link');
t('no scheme, as X displays it', () => {
  assert.deepStrictEqual(parseSealLink(`peal.network/#/s/${CODE}`), {
    kind: 'code',
    value: CODE,
  });
});
t('surrounding whitespace', () => {
  assert.ok(parseSealLink(`  https://peal.network/#/s/${CODE}  `));
});
t('www host', () => {
  assert.ok(parseSealLink(`https://www.peal.network/#/s/${CODE}`));
});
t('truncated with an ellipsis is refused, not guessed', () => {
  assert.strictEqual(parseSealLink('peal.network/#/s/bPGLBT…'), null);
  assert.strictEqual(parseSealLink('peal.network/#/s/bPGLBT...'), null);
});

console.log('\nrefuses everything else');
t('t.co href gives nothing away', () => {
  assert.strictEqual(parseSealLink('https://t.co/abc123'), null);
});
t('another host that merely mentions peal', () => {
  assert.strictEqual(parseSealLink('https://evil.example/peal.network/#/s/' + CODE), null);
});
t('lookalike host', () => {
  assert.strictEqual(parseSealLink(`https://peal.network.evil.com/#/s/${CODE}`), null);
});
t('other peal routes are not seals', () => {
  assert.strictEqual(parseSealLink('https://peal.network/#/protocol'), null);
  assert.strictEqual(parseSealLink('https://peal.network/#/philosophy'), null);
  assert.strictEqual(parseSealLink(`https://peal.network/#/condition/${COND}`), null);
  assert.strictEqual(parseSealLink('https://peal.network/'), null);
});
t('wrong code length', () => {
  assert.strictEqual(parseSealLink('https://peal.network/#/s/tooshort12'), null);
  assert.strictEqual(parseSealLink('https://peal.network/#/s/waytoolong123'), null);
});
t('junk input', () => {
  assert.strictEqual(parseSealLink(''), null);
  assert.strictEqual(parseSealLink(null), null);
  assert.strictEqual(parseSealLink(undefined), null);
  assert.strictEqual(parseSealLink(42), null);
  assert.strictEqual(parseSealLink('not a url at all'), null);
});

console.log('\nTHE PRIVACY INVARIANT: the AES key never survives parsing');
for (const link of [
  `https://peal.network/#/s/${CODE}/${KEY}`,
  `https://peal.network/#/s/${COND}/${CT}/${KEY}`,
  `peal.network/#/s/${CODE}/${KEY}`,
  `https://peal.network/s/${CODE}/${KEY}`,
]) {
  t('key absent from parse output: ' + link.slice(0, 46) + '…', () => {
    const out = parseSealLink(link);
    assert.ok(out, 'should still parse');
    const serialised = JSON.stringify(out) + '|' + handleKey(out);
    assert.ok(
      !serialised.includes(KEY),
      'the share key leaked into the parsed handle: ' + serialised,
    );
    // and no fragment of it either
    assert.ok(!serialised.includes(KEY.slice(0, 8)), 'a prefix of the key leaked');
  });
}

t('handleKey is stable and carries only the handle', () => {
  assert.strictEqual(handleKey({ kind: 'code', value: CODE }), 'code:' + CODE);
  assert.strictEqual(handleKey({ kind: 'condition', value: COND }), 'condition:' + COND);
});

console.log(
  `\n${passed} passed${process.exitCode ? ', SOME FAILED' : ', 0 failed'}\n`,
);
