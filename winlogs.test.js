const test = require('node:test');
const assert = require('node:assert');
const { readCmd, tailCmd, stripHeartbeat, isEventLog, winPath, psQuote, removeCmd, tarDirCmd, HEARTBEAT } = require('./winlogs');

test('Windows delete: literal path, never a drive root', () => {
  const s = Buffer.from(removeCmd('/C:/Users/me/old dir').split(' ').pop(), 'base64').toString('utf16le');
  assert.match(s, /Remove-Item -LiteralPath 'C:\/Users\/me\/old dir' -Recurse -Force/);
  for (const bad of ['/C:/', 'C:\\', 'C:', '/', '', null]) assert.throws(() => removeCmd(bad), /Refusing/);
});

test('Windows folder download uses built-in tar via cmd', () => {
  assert.strictEqual(tarDirCmd('/C:/inetpub/logs'), 'cmd /c tar -czf - -C "C:/inetpub" "logs"');
  assert.strictEqual(tarDirCmd('/C:/data'), 'cmd /c tar -czf - -C "C:/" "data"');
  assert.throws(() => tarDirCmd('/C:/a&calc'), /Cannot archive/);
});

// Decode the -EncodedCommand payload back to the PowerShell script it carries.
const script = cmd => {
  const m = cmd.match(/^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/);
  assert.ok(m, 'one encoded command, nothing else on the command line');
  return Buffer.from(m[1], 'base64').toString('utf16le');
};

test('paths: SFTP form and quoting', () => {
  assert.strictEqual(winPath('/C:/ProgramData/ssh/logs/sshd.log'), 'C:/ProgramData/ssh/logs/sshd.log');
  assert.strictEqual(winPath('C:\\logs\\app.log'), 'C:\\logs\\app.log');
  assert.strictEqual(psQuote("it's"), "'it''s'");
});

test('file read/tail: path stays a literal, no injection', () => {
  const evil = "C:\\logs\\a'; Remove-Item C:\\ -Recurse; '.log";
  const r = script(readCmd(evil, 200));
  assert.match(r, /Get-Content -LiteralPath 'C:\\logs\\a''; Remove-Item C:\\ -Recurse; ''\.log' -Tail 200/);
  const t = script(tailCmd('/C:/app/app.log', 50));
  assert.match(t, /\$p = 'C:\/app\/app\.log'/);
  assert.match(t, /-Tail 50/);
  assert.ok(t.includes(HEARTBEAT));
  assert.match(script(readCmd('x', 'abc')), /-Tail 500/); // bad count → default
});

test('event logs', () => {
  assert.ok(isEventLog('eventlog:System') && isEventLog('EventLog:Application') && !isEventLog('C:\\x.log'));
  const r = script(readCmd('eventlog:Microsoft-Windows-OpenSSH/Operational', 100));
  assert.match(r, /Get-WinEvent -LogName 'Microsoft-Windows-OpenSSH\/Operational' -MaxEvents 100/);
  assert.match(r, /yyyy-MM-ddTHH:mm:sszzz/); // ISO time for the time filter
  assert.match(script(tailCmd('eventlog:System', 10)), /RecordId -gt \$last/);
  assert.throws(() => readCmd("eventlog:Sys'tem", 10), /Invalid event log name/);
});

test('heartbeat is removed from the stream', () => {
  assert.strictEqual(stripHeartbeat(`a\n${HEARTBEAT}\r\nb\n`), 'a\nb\n');
  assert.strictEqual(stripHeartbeat(`partial${HEARTBEAT}\nrest`), 'partialrest');
});
