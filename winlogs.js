// Windows log reading/tailing over SSH, via PowerShell (works whether the server's SSH shell is cmd or PowerShell).
// Scripts go as -EncodedCommand (base64 UTF-16LE), so paths with quotes/spaces can never break out.
// Sources: a file path (C:\x\app.log, or SFTP-style /C:/x/app.log) or an Event Log as "eventlog:<LogName>".

const HEARTBEAT = '##ET-HB##'; // tails print this every few seconds: if the SSH channel is gone the write
// fails and PowerShell exits, so no tail is left running on the server. main.js strips it from the stream.

const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;
const psEncode = script => Buffer.from(script, 'utf16le').toString('base64');
const psCommand = script => `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${psEncode(script)}`;
// SFTP shows Windows paths as /C:/dir/file
const winPath = p => String(p).replace(/^\/(?=[A-Za-z]:)/, '');
const isEventLog = src => /^eventlog:/i.test(String(src));
function eventLogName(src) {
  const name = String(src).replace(/^eventlog:/i, '').trim();
  if (!/^[\w .\-/]{1,200}$/.test(name)) throw new Error(`Invalid event log name: ${name}`);
  return name;
}
const lineCount = n => Math.min(Math.max(parseInt(n, 10) || 500, 1), 100000);

const PRELUDE = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;
// One event per line, in a shape logLevel()/parseLogTime() understand: ISO time, LEVEL, [source] id: message
const FMT_EVENT = `function Fmt($e){ $lv = switch($e.Level){1{'CRITICAL'}2{'ERROR'}3{'WARNING'}5{'DEBUG'}default{'INFO'}}
  $m = if ($e.Message) { $e.Message -replace '\\s+',' ' } else { '(no message text)' }
  '{0} {1} [{2}] {3}: {4}' -f $e.TimeCreated.ToString('yyyy-MM-ddTHH:mm:sszzz'), $lv, $e.ProviderName, $e.Id, $m }
`;

function readCmd(src, n) {
  const N = lineCount(n);
  if (isEventLog(src)) {
    return psCommand(PRELUDE + FMT_EVENT +
      `Get-WinEvent -LogName ${psQuote(eventLogName(src))} -MaxEvents ${N} -ErrorAction SilentlyContinue | Sort-Object RecordId | ForEach-Object { Fmt $_ }`);
  }
  return psCommand(PRELUDE + `Get-Content -LiteralPath ${psQuote(winPath(src))} -Tail ${N}`);
}

function tailCmd(src, n) {
  const N = lineCount(n);
  if (isEventLog(src)) {
    const log = psQuote(eventLogName(src));
    return psCommand(PRELUDE + FMT_EVENT + `$last = 0
Get-WinEvent -LogName ${log} -MaxEvents ${N} -ErrorAction SilentlyContinue | Sort-Object RecordId | ForEach-Object { Fmt $_; $last = $_.RecordId }
$i = 0
while ($true) {
  Start-Sleep -Seconds 2
  Get-WinEvent -LogName ${log} -MaxEvents 200 -ErrorAction SilentlyContinue | Where-Object { $_.RecordId -gt $last } | Sort-Object RecordId | ForEach-Object { Fmt $_; $last = $_.RecordId }
  if ((++$i % 3) -eq 0) { [Console]::Out.WriteLine('${HEARTBEAT}') }
  [Console]::Out.Flush()
}`);
  }
  // Follow by byte offset; handles truncation/rotation (file shrinks → start over).
  return psCommand(PRELUDE + `$p = ${psQuote(winPath(src))}
Get-Content -LiteralPath $p -Tail ${N}
$pos = (Get-Item -LiteralPath $p).Length
$i = 0
while ($true) {
  Start-Sleep -Seconds 1
  $len = (Get-Item -LiteralPath $p -ErrorAction SilentlyContinue).Length
  if ($len -ne $null) {
    if ($len -lt $pos) { $pos = 0 }
    if ($len -gt $pos) {
      $fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite,Delete')
      [void]$fs.Seek($pos, 'Begin'); $sr = New-Object IO.StreamReader($fs, $true)
      [Console]::Out.Write($sr.ReadToEnd()); $pos = $fs.Position; $sr.Close()
    }
  }
  if ((++$i % 5) -eq 0) { [Console]::Out.WriteLine('${HEARTBEAT}') }
  [Console]::Out.Flush()
}`);
}

const stripHeartbeat = s => s.replace(new RegExp(`${HEARTBEAT}\\r?\\n`, 'g'), '');

module.exports = { readCmd, tailCmd, stripHeartbeat, isEventLog, winPath, psQuote, psEncode, HEARTBEAT };
