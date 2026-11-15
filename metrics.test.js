const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { parseMetrics, TOP_CMD, parseTop } = require('./metrics');

test('parseTop: Linux and macOS uptime formats', () => {
  const linux = parseTop([
    'UPTIME  13:32:28 up 3 days,  2:01,  2 users,  load average: 0.52, 0.31, 0.12',
    'CORES 4',
    'PROC 1234 root     25.0  3.1 204800 java',
    'PROC  987 www-data  1.5  0.2   8192 nginx: worker',
  ].join('\n'));
  assert.deepStrictEqual(linux.load, [0.52, 0.31, 0.12]);
  assert.strictEqual(linux.uptime, '3 days,  2:01');
  assert.strictEqual(linux.cores, 4);
  assert.deepStrictEqual(linux.procs[0], { pid: 1234, user: 'root', cpu: 25, mem: 3.1, rss: 204800 * 1024, command: 'java' });
  assert.strictEqual(linux.procs[1].command, 'nginx: worker');
  const mac = parseTop('UPTIME 15:17  up 8 mins, 3 users, load averages: 2.10 1.95 1.80\nCORES 10\n');
  assert.deepStrictEqual(mac.load, [2.1, 1.95, 1.8]);
  assert.strictEqual(mac.uptime, '8 mins');
  assert.deepStrictEqual(parseTop('garbage'),
    { uptime: '', load: null, cores: null, procs: [], swapTotal: null, swapUsed: null, memAvail: null });
  const sw = parseTop('SWAP 2147483648 1073741824\nMEMAVAIL 2630000000\n');
  assert.deepStrictEqual([sw.swapTotal, sw.swapUsed, sw.memAvail], [2147483648, 1073741824, 2630000000]);
});

test('TOP_CMD runs on this machine', () => {
  const r = parseTop(execFileSync('sh', ['-c', TOP_CMD('cpu')]).toString());
  assert.ok(r.procs.length > 0 && r.procs.length <= 15);
  assert.ok(r.cores > 0);
  assert.ok(r.load && r.load.length === 3);
  assert.ok(Number.isFinite(r.swapTotal) && r.swapTotal >= 0); // macOS sysctl path on this machine
  const cpu = r.procs.map(p => p.cpu);
  assert.deepStrictEqual(cpu, [...cpu].sort((a, b) => b - a)); // sorted by CPU, descending
});

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

test('parseMetrics macOS', () => {
  const m = parseMetrics('CPUIDLE 62.19\nMEM 25769803776 18765398016\nDISK 494332366848 306877767680\n');
  assert.strictEqual(m.cpu, 38);
  assert.strictEqual(m.memTotal, 25769803776);
  assert.strictEqual(m.diskUsed, 306877767680);
});
