const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { killCmd, SCAN_CMD, parseScan, cleanCmd } = require('./maint');

test('killCmd only accepts a single real PID', () => {
  assert.strictEqual(killCmd(1234, false), 'kill -TERM 1234');
  assert.strictEqual(killCmd('1234', true), 'kill -KILL 1234');
  for (const bad of [0, 1, -1, '12; rm -rf /', '1e3x', 3.5, null]) assert.throws(() => killCmd(bad), /Refusing/);
});

test('disk scan runs read-only here and parses', () => {
  const r = parseScan(execFileSync('sh', ['-c', SCAN_CMD]).toString()); // scan never deletes
  assert.deepStrictEqual(r.map(i => i.id), ['tmp', 'oldlogs', 'journal', 'pkg']);
  for (const i of r) assert.ok(Number.isInteger(i.bytes) && i.bytes >= 0, `${i.id}: ${i.bytes}`);
  assert.strictEqual(parseScan('garbage')[0].bytes, null);
});

test('cleanCmd uses only known categories', () => {
  assert.match(cleanCmd(['tmp']), /^find \/tmp \/var\/tmp .* -delete/);
  assert.doesNotMatch(cleanCmd(['tmp']), /journalctl/);
  assert.throws(() => cleanCmd(['rm -rf /']), /Nothing selected/);
  assert.throws(() => cleanCmd([]), /Nothing selected/);
});
