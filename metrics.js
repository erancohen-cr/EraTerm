// One SSH exec gathers everything; no agent on the server.
const METRICS_CMD =
  "head -1 /proc/stat; sleep 0.5; head -1 /proc/stat; " +
  "free -b | awk '/^Mem:/{print \"MEM\",$2,$3}'; " +
  "df -B1 / | awk 'NR==2{print \"DISK\",$2,$3}'";

function parseMetrics(stdout) {
  const lines = stdout.trim().split('\n');
  const cpus = lines.filter(l => l.startsWith('cpu ')).map(l => l.trim().split(/\s+/).slice(1).map(Number));
  let cpu = null;
  if (cpus.length === 2) {
    const total = a => a.reduce((s, n) => s + n, 0);
    const idle = a => a[3] + (a[4] || 0); // idle + iowait
    const dt = total(cpus[1]) - total(cpus[0]);
    cpu = dt > 0 ? Math.round((1 - (idle(cpus[1]) - idle(cpus[0])) / dt) * 100) : 0;
  }
  const pick = tag => {
    const l = lines.find(x => x.startsWith(tag + ' '));
    return l ? l.split(/\s+/).slice(1).map(Number) : [null, null];
  };
  const [memTotal, memUsed] = pick('MEM');
  const [diskTotal, diskUsed] = pick('DISK');
  return { cpu, memUsed, memTotal, diskUsed, diskTotal };
}

module.exports = { METRICS_CMD, parseMetrics };
