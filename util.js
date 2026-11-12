// Shared by main (require) and renderer (<script>).
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote for remote shell commands

function logLevel(line) {
  if (/\b(ERROR|ERR|FATAL|CRIT(ICAL)?|SEVERE)\b/i.test(line)) return 'error';
  if (/\bWARN(ING)?\b/i.test(line)) return 'warn';
  if (/\bINFO\b/i.test(line)) return 'info';
  if (/\b(DEBUG|TRACE)\b/i.test(line)) return 'debug';
  return '';
}

if (typeof module !== 'undefined') module.exports = { shq, logLevel };
