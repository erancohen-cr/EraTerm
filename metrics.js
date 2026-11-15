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

// Top processes + uptime/load/cores. Same ps flags work on Linux (procps) and macOS (BSD ps).
// sortBy: 'cpu' | 'mem'. ponytail: fixed 15 rows; make it a parameter if someone needs more.
const TOP_CMD = sortBy => `echo "UPTIME $(uptime)"; echo "CORES $(getconf _NPROCESSORS_ONLN 2>/dev/null)"
if [ "$(uname -s)" = Darwin ]; then
  sysctl -n vm.swapusage 2>/dev/null | awk 'function b(x){u=substr(x,length(x));v=x+0;return u=="G"?v*1073741824:u=="M"?v*1048576:u=="K"?v*1024:v} {print "SWAP", b($3), b($6)}'
else
  free -b 2>/dev/null | awk '/^Mem:/{print "MEMAVAIL", $7} /^Swap:/{print "SWAP", $2, $3}'
fi
ps -eo pid,user,pcpu,pmem,rss,comm | tail -n +2 | sort -k${sortBy === 'mem' ? 4 : 3} -nr | head -n 15 | sed 's/^ */PROC /'`;

function parseTop(stdout) {
  const lines = stdout.split('\n');
  const up = (lines.find(l => l.startsWith('UPTIME ')) || '').slice(7);
  const load = (up.match(/load averages?:\s*([\d.,]+)[,\s]+([\d.,]+)[,\s]+([\d.,]+)/) || []).slice(1, 4)
    .map(x => Number(x.replace(/,$/, '').replace(',', '.')));
  const uptime = (up.match(/up\s+(.*?),\s+\d+\s+users?/) || up.match(/up\s+(.*?),\s+load/) || [])[1] || '';
  const cores = Number((lines.find(l => l.startsWith('CORES ')) || '').slice(6)) || null;
  const procs = lines.filter(l => l.startsWith('PROC ')).map(l => {
    const [pid, user, cpu, mem, rss, ...cmd] = l.slice(5).trim().split(/\s+/);
    return { pid: Number(pid), user, cpu: Number(cpu), mem: Number(mem), rss: Number(rss) * 1024, command: cmd.join(' ') };
  }).filter(p => Number.isFinite(p.pid));
  const nums = tag => ((lines.find(l => l.startsWith(tag + ' ')) || '').split(/\s+/).slice(1).map(Number));
  const [swapTotal = null, swapUsed = null] = nums('SWAP');
  const [memAvail = null] = nums('MEMAVAIL');
  return { uptime: uptime.trim(), load: load.length === 3 ? load : null, cores, procs, swapTotal, swapUsed, memAvail };
}

module.exports = { METRICS_CMD, parseMetrics, TOP_CMD, parseTop };
