// Shared by main (require) and renderer (<script>).
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single-quote for remote shell commands

function logLevel(line) {
  if (/\b(ERROR|ERR|FATAL|CRIT(ICAL)?|SEVERE)\b/i.test(line)) return 'error';
  if (/\bWARN(ING)?\b/i.test(line)) return 'warn';
  if (/\bINFO\b/i.test(line)) return 'info';
  if (/\b(DEBUG|TRACE)\b/i.test(line)) return 'debug';
  return '';
}

// .rdp files are line-based "key:type:value"; strip newlines so a value can't inject extra settings.
// No password: macOS Windows App can't read one from a file; it prompts and keeps it in its keychain.
function buildRdp({ host, port, username, domain }) {
  const clean = v => String(v ?? '').replace(/[\r\n]/g, '');
  const user = domain ? `${clean(domain)}\\${clean(username)}` : clean(username);
  return [
    `full address:s:${clean(host)}:${Number(port) || 3389}`,
    user && `username:s:${user}`,
    'screen mode id:i:1',          // windowed
    'dynamic resolution:i:1',      // resize desktop with the window
    'redirectclipboard:i:1',
    'audiomode:i:0',               // play sound locally
    'authentication level:i:2',    // warn (don't fail) on untrusted certificates
  ].filter(Boolean).join('\r\n') + '\r\n';
}

if (typeof module !== 'undefined') module.exports = { shq, logLevel, buildRdp };
