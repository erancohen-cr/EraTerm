// One SSH exec gathers everything; no agent on the server. Linux and macOS.
// macOS: CPU from top (idle %), memory = active + wired + compressed pages, disk from the Data volume
// (on APFS "/" is the small sealed system volume, so used = total - available).
const METRICS_CMD = `if [ "$(uname -s)" = Darwin ]; then
  top -l 2 -n 0 -s 1 | awk '/CPU usage/{i=$7} END{sub("%","",i); print "CPUIDLE", i}'
  /usr/bin/vm_stat | awk -v t="$(/usr/sbin/sysctl -n hw.memsize)" '/page size of/{ps=$8} /Pages active/{a=$3} /Pages wired down/{w=$4} /occupied by compressor/{c=$5} END{print "MEM", t, (a+w+c)*ps}'
  d=/System/Volumes/Data; [ -d "$d" ] || d=/
  df -k "$d" | awk 'NR==2{print "DISK", $2*1024, ($2-$4)*1024}'
else
  head -1 /proc/stat; sleep 0.5; head -1 /proc/stat
  free -b | awk '/^Mem:/{print "MEM",$2,$3}'
  df -B1 / | awk 'NR==2{print "DISK",$2,$3}'
fi`;

function parseMetrics(stdout) {
  const lines = stdout.trim().split('\n');
  const pick = tag => {
    const l = lines.find(x => x.startsWith(tag + ' '));
    return l ? l.trim().split(/\s+/).slice(1).map(Number) : [null, null];
  };
  let cpu = null;
  const cpus = lines.filter(l => l.startsWith('cpu ')).map(l => l.trim().split(/\s+/).slice(1).map(Number));
  if (cpus.length === 2) {
    const total = a => a.reduce((s, n) => s + n, 0);
    const idle = a => a[3] + (a[4] || 0); // idle + iowait
    const dt = total(cpus[1]) - total(cpus[0]);
    cpu = dt > 0 ? Math.round((1 - (idle(cpus[1]) - idle(cpus[0])) / dt) * 100) : 0;
  }
  const [idlePct] = pick('CPUIDLE');
  if (cpu == null && Number.isFinite(idlePct)) cpu = Math.round(100 - idlePct);
  const [memTotal, memUsed] = pick('MEM');
  const [diskTotal, diskUsed] = pick('DISK');
  return { cpu, memUsed, memTotal, diskUsed, diskTotal };
}

module.exports = { METRICS_CMD, parseMetrics };
