const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { shq, logLevel, buildRdp } = require('./util');

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

test('buildRdp', () => {
  const f = buildRdp({ host: 'win01', port: 3390, username: 'admin', domain: 'CORP' });
  assert.match(f, /^full address:s:win01:3390\r\n/);
  assert.match(f, /\r\nusername:s:CORP\\admin\r\n/);
  assert.match(buildRdp({ host: 'h' }), /full address:s:h:3389/);
  assert.doesNotMatch(buildRdp({ host: 'h' }), /username/);
  // newline injection can't add a setting line
  const evil = buildRdp({ host: 'h', username: 'x\r\ndrivestoredirect:s:*' });
  assert.doesNotMatch(evil, /^drivestoredirect/m);
});
