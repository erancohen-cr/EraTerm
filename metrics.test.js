const test = require('node:test');
const assert = require('node:assert');
const { parseMetrics } = require('./metrics');

test('parseMetrics', () => {
  const out = [
    'cpu  100 0 100 700 100 0 0 0 0 0',
    'cpu  150 0 150 750 100 0 0 0 0 0', // +150 total, +50 idle → 67% busy
    'MEM 8000 2000',
    'DISK 100000 25000',
  ].join('\n');
  assert.deepStrictEqual(parseMetrics(out), {
    cpu: 67, memTotal: 8000, memUsed: 2000, diskTotal: 100000, diskUsed: 25000,
  });
  assert.strictEqual(parseMetrics('garbage').cpu, null);
});
