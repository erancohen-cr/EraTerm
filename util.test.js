const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { shq, logLevel } = require('./util');

test('shq survives quotes, spaces and $', () => {
  const nasty = `it's a "file" $(rm -rf /) ; x`;
  assert.strictEqual(execFileSync('sh', ['-c', `printf %s ${shq(nasty)}`]).toString(), nasty);
});

test('logLevel', () => {
  assert.strictEqual(logLevel('3165 ERROR 10755 MinionHost.cpp:786 end'), 'error');
  assert.strictEqual(logLevel('3170 WARNING 10755 disconnected'), 'warn');
  assert.strictEqual(logLevel('[warn] disk'), 'warn');
  assert.strictEqual(logLevel('3166 INFO 10755 Got RPC request'), 'info');
  assert.strictEqual(logLevel('plain line'), '');
  assert.strictEqual(logLevel('INFORMATION'), ''); // word boundary
});
