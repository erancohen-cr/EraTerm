// Server maintenance commands (run over SSH, usually through sudo). Pure builders so they can be tested.

// Kill one process. pid must be a plain integer > 1 (never 0/1/-1: those mean "group", "init", "everything").
function killCmd(pid, force) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) throw new Error(`Refusing to kill PID ${pid}`);
  return `kill -${force ? 'KILL' : 'TERM'} ${n}`;
}

// Drop page cache / buffers. Linux: drop_caches (safe, data is synced first). macOS: purge.
const DROP_CACHES_CMD = `if [ "$(uname -s)" = Darwin ]; then purge; else sync && echo 3 > /proc/sys/vm/drop_caches; fi`;

// Disk cleanup categories. scan prints bytes that run would free; run deletes. Paths are fixed: nothing user-supplied.
const SIZE_OF_FIND = 'awk \'{s+=$7} END{print s+0}\''; // `find -ls` column 7 = size (GNU and BSD find)
const OLD_LOGS = `/var/log -type f \\( -name '*.gz' -o -name '*.bz2' -o -name '*.xz' -o -name '*.zst' -o -name '*.[0-9]' -o -name '*.old' \\)`;
const CLEAN_ITEMS = [
  {
    id: 'tmp', label: 'Temp files older than 7 days', detail: '/tmp, /var/tmp',
    scan: `find /tmp /var/tmp -xdev -type f -mtime +7 -ls 2>/dev/null | ${SIZE_OF_FIND}`,
    run: 'find /tmp /var/tmp -xdev -type f -mtime +7 -delete 2>/dev/null; true',
  },
  {
    id: 'oldlogs', label: 'Rotated / compressed logs', detail: '/var/log: *.gz, *.1, *.old … (current logs are kept)',
    scan: `find ${OLD_LOGS} -ls 2>/dev/null | ${SIZE_OF_FIND}`,
    run: `find ${OLD_LOGS} -delete 2>/dev/null; true`,
  },
  {
    id: 'journal', label: 'systemd journal older than 7 days', detail: 'journalctl --vacuum-time=7d (Linux)',
    scan: `command -v journalctl >/dev/null && du -sk /var/log/journal 2>/dev/null | awk '{print $1*1024}' || echo 0`,
    run: 'command -v journalctl >/dev/null && journalctl --vacuum-time=7d; true',
  },
  {
    id: 'pkg', label: 'Package manager cache', detail: 'apt / dnf / yum downloaded packages',
    scan: `du -sk /var/cache/apt/archives /var/cache/dnf /var/cache/yum 2>/dev/null | awk '{s+=$1} END{print s*1024}'`,
    run: 'command -v apt-get >/dev/null && apt-get clean; command -v dnf >/dev/null && dnf clean all; command -v yum >/dev/null && yum clean all; true',
  },
];

const SCAN_CMD = CLEAN_ITEMS.map(i => `echo "SIZE ${i.id} $(${i.scan})"`).join('\n');

function parseScan(stdout) {
  const sizes = {};
  for (const l of stdout.split('\n')) {
    const m = l.match(/^SIZE (\w+) (\d+)/);
    if (m) sizes[m[1]] = Number(m[2]);
  }
  return CLEAN_ITEMS.map(({ id, label, detail }) => ({ id, label, detail, bytes: sizes[id] ?? null }));
}

// Only known ids are accepted; the command text never comes from the renderer.
function cleanCmd(ids) {
  const picked = CLEAN_ITEMS.filter(i => ids.includes(i.id));
  if (!picked.length) throw new Error('Nothing selected to clean');
  return picked.map(i => i.run).join('\n');
}

module.exports = { killCmd, DROP_CACHES_CMD, CLEAN_ITEMS, SCAN_CMD, parseScan, cleanCmd };
