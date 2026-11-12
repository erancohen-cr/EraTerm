const { app, BrowserWindow, ipcMain, safeStorage, dialog } = require('electron');
const { Client } = require('ssh2');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { METRICS_CMD, parseMetrics } = require('./metrics');
const { shq } = require('./util');

const AI_MODEL = 'claude-sonnet-5-5';
const rpath = path.posix;

// ponytail: JSON files in userData; move to SQLite if the server list gets large.
const dataFile = name => path.join(app.getPath('userData'), name);
const readJson = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch { return fallback; }
};
const writeJson = (name, v) => fs.writeFileSync(dataFile(name), JSON.stringify(v, null, 2), { mode: 0o600 });

const enc = s => safeStorage.encryptString(s).toString('base64');
const dec = s => safeStorage.decryptString(Buffer.from(s, 'base64'));

let win;
const send = (...a) => win?.webContents.send(...a);
const conns = new Map();  // connId -> { conn, serverId, uname, sftp, err }
const shells = new Map(); // shellId -> stream
const tails = new Map();  // tailId -> stream

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 880, title: 'EraTerm', backgroundColor: '#0b0d10',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile('index.html');
}

// callback -> promise
const p = fn => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));
const getConn = id => {
  const c = conns.get(id);
  if (!c) throw new Error('Not connected');
  return c;
};

// ---------- servers ----------
// Renderer never sees stored secrets: passwordEnc stays in main.
const publicServer = ({ passwordEnc, ...s }) => ({ ...s, hasPassword: !!passwordEnc });
const servers = () => readJson('servers.json', []);
const patchServer = (id, patch) => writeJson('servers.json', servers().map(x => (x.id === id ? { ...x, ...patch } : x)));

ipcMain.handle('servers:list', () => servers().map(publicServer));

ipcMain.handle('servers:save', (_e, s) => {
  const list = servers();
  const prev = list.find(x => x.id === s.id);
  const rec = {
    ...prev, // keeps lastSeen, logPaths
    id: s.id || crypto.randomUUID(),
    name: String(s.name || s.host), host: String(s.host), port: Number(s.port) || 22,
    username: String(s.username), keyPath: s.keyPath || '',
    tags: Array.isArray(s.tags) ? s.tags : [], starred: !!s.starred,
    passwordEnc: s.password ? enc(s.password) : prev?.passwordEnc || '',
  };
  writeJson('servers.json', prev ? list.map(x => (x.id === rec.id ? rec : x)) : [...list, rec]);
  return publicServer(rec);
});

ipcMain.handle('servers:setLogPaths', (_e, id, paths) => patchServer(id, { logPaths: paths.map(String) }));

ipcMain.handle('servers:delete', (_e, id) => {
  writeJson('servers.json', servers().filter(x => x.id !== id));
  const kh = readJson('known_hosts.json', {});
  delete kh[id];
  writeJson('known_hosts.json', kh);
});

// ---------- settings ----------
ipcMain.handle('settings:get', () => ({
  hasApiKey: !!(process.env.ANTHROPIC_API_KEY || readJson('settings.json', {}).apiKeyEnc),
  fromEnv: !!process.env.ANTHROPIC_API_KEY,
}));
ipcMain.handle('settings:setApiKey', (_e, key) => {
  writeJson('settings.json', { ...readJson('settings.json', {}), apiKeyEnc: key ? enc(key) : '' });
});
const apiKey = () => {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const e = readJson('settings.json', {}).apiKeyEnc;
  return e ? dec(e) : '';
};

// ---------- ssh ----------
// check=true rejects on non-zero exit with stderr as the message.
const exec = (conn, cmd, check = false) => new Promise((resolve, reject) => {
  conn.exec(cmd, (err, stream) => {
    if (err) return reject(err);
    let out = '', errOut = '';
    stream.on('data', d => (out += d)).on('close', code =>
      check && code ? reject(new Error(errOut.trim() || `exit ${code}`)) : resolve(out));
    stream.stderr.on('data', d => (errOut += d));
  });
});

ipcMain.handle('ssh:connect', (_e, serverId) => new Promise((resolve, reject) => {
  const s = servers().find(x => x.id === serverId);
  if (!s) return reject(new Error('Server not found'));
  const connId = crypto.randomUUID();
  const conn = new Client();
  let hostKeyError = null;

  const cfg = {
    host: s.host, port: s.port, username: s.username, readyTimeout: 15000, keepaliveInterval: 15000,
    hostHash: 'sha256',
    // Trust on first use; refuse if the key changes later.
    hostVerifier: fp => {
      const kh = readJson('known_hosts.json', {});
      if (!kh[serverId]) { kh[serverId] = fp; writeJson('known_hosts.json', kh); return true; }
      if (kh[serverId] === fp) return true;
      hostKeyError = `HOST KEY CHANGED for ${s.host}. Expected ${kh[serverId]}, got ${fp}. ` +
        'Connection refused. If the change is legitimate, delete and re-add the server.';
      return false;
    },
  };
  try {
    if (s.keyPath) cfg.privateKey = fs.readFileSync(s.keyPath.replace(/^~(?=\/)/, os.homedir()));
  } catch (err) { return reject(new Error(`Cannot read key ${s.keyPath}: ${err.message}`)); }
  if (s.passwordEnc) cfg.password = dec(s.passwordEnc);
  if (!s.keyPath && !s.passwordEnc && process.env.SSH_AUTH_SOCK) cfg.agent = process.env.SSH_AUTH_SOCK;

  conn.on('ready', () => {
    const c = { conn, serverId, uname: '', sftp: null, err: null };
    conns.set(connId, c);
    exec(conn, 'uname -a').then(u => (c.uname = u.trim())).catch(() => {});
    patchServer(serverId, { lastSeen: Date.now() });
    resolve(connId);
  });
  conn.on('error', err => {
    if (conns.has(connId)) conns.get(connId).err = err.message;
    else reject(new Error(hostKeyError || err.message));
  });
  conn.on('close', () => {
    const c = conns.get(connId);
    if (c && conns.delete(connId)) send('ssh:connClosed', connId, c.err);
  });
  conn.connect(cfg);
}));

ipcMain.on('ssh:disconnect', (_e, connId) => conns.get(connId)?.conn.end());

ipcMain.handle('ssh:shell', async (_e, connId, cols, rows, cwd) => {
  const stream = await p(cb => getConn(connId).conn.shell({ term: 'xterm-256color', cols, rows }, cb));
  const id = crypto.randomUUID();
  shells.set(id, stream);
  stream.on('data', d => send('ssh:data', id, d)); // raw bytes: xterm decodes UTF-8 across chunks
  stream.on('close', () => { shells.delete(id); send('ssh:closed', id); });
  if (cwd) stream.write(`cd ${shq(cwd)} && clear\n`);
  return id;
});
ipcMain.on('ssh:write', (_e, id, data) => shells.get(id)?.write(data));
ipcMain.on('ssh:resize', (_e, id, cols, rows) => shells.get(id)?.setWindow(rows, cols, 0, 0));
ipcMain.on('ssh:closeShell', (_e, id) => shells.get(id)?.close());

// ponytail: renderer polls only the visible server; fleet-wide view would poll every server.
ipcMain.handle('ssh:metrics', async (_e, connId) => parseMetrics(await exec(getConn(connId).conn, METRICS_CMD)));

// ---------- files (SFTP) ----------
const sftpOf = connId => {
  const c = getConn(connId);
  return (c.sftp ||= p(cb => c.conn.sftp(cb)));
};
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;

ipcMain.handle('sftp:list', async (_e, connId, dir) => {
  const sftp = await sftpOf(connId);
  const home = await p(cb => sftp.realpath('.', cb));
  const want = !dir ? home : dir.replace(/^~(?=\/|$)/, home);
  const real = await p(cb => sftp.realpath(want, cb));
  const list = await p(cb => sftp.readdir(real, cb));
  const entries = await Promise.all(list.map(async ({ filename, attrs }) => {
    const full = rpath.join(real, filename);
    const kind = attrs.mode & S_IFMT;
    let type = kind === S_IFDIR ? 'dir' : 'file', link = '';
    if (kind === S_IFLNK) {
      link = await p(cb => sftp.readlink(full, cb)).catch(() => '?');
      const st = await p(cb => sftp.stat(full, cb)).catch(() => null);
      type = st && (st.mode & S_IFMT) === S_IFDIR ? 'dir' : 'file';
    }
    return { name: filename, path: full, type, link, size: attrs.size, mtime: attrs.mtime * 1000 };
  }));
  return { path: real, entries };
});

ipcMain.handle('sftp:mkdir', async (_e, connId, dir) => {
  const sftp = await sftpOf(connId);
  await p(cb => sftp.mkdir(dir, cb));
});

ipcMain.handle('sftp:delete', (_e, connId, target) => {
  if (!target || target === '/') throw new Error('Refusing to delete /');
  return exec(getConn(connId).conn, `rm -rf -- ${shq(target)}`, true);
});

// Folders travel as tar.gz streams; files via SFTP.
ipcMain.handle('sftp:download', async (_e, connId, remote, isDir) => {
  const name = rpath.basename(remote) || 'root';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), isDir ? `${name}.tar.gz` : name),
  });
  if (canceled) return null;
  if (!isDir) {
    const sftp = await sftpOf(connId);
    await p(cb => sftp.fastGet(remote, filePath, cb));
  } else {
    const cmd = `tar czf - -C ${shq(rpath.dirname(remote))} ${shq(name)}`;
    await new Promise((resolve, reject) => getConn(connId).conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      const out = fs.createWriteStream(filePath);
      stream.pipe(out).on('finish', resolve).on('error', reject);
    }));
  }
  return filePath;
});

const tarUpload = (conn, local, remoteDir) => new Promise((resolve, reject) => {
  conn.exec(`tar xzf - -C ${shq(remoteDir)}`, (err, stream) => {
    if (err) return reject(err);
    const t = spawn('tar', ['czf', '-', '-C', path.dirname(local), path.basename(local)],
      { env: { ...process.env, COPYFILE_DISABLE: '1' } }); // no macOS ._ files
    t.on('error', reject);
    t.stdout.pipe(stream);
    stream.on('close', code => (code ? reject(new Error(`remote tar exit ${code}`)) : resolve()));
  });
});

ipcMain.handle('sftp:upload', async (_e, connId, remoteDir, locals) => {
  if (!locals?.length) {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
    if (r.canceled) return 0;
    locals = r.filePaths;
  }
  const sftp = await sftpOf(connId);
  for (const lp of locals) {
    if (fs.statSync(lp).isDirectory()) await tarUpload(getConn(connId).conn, lp, remoteDir);
    else await p(cb => sftp.fastPut(lp, rpath.join(remoteDir, path.basename(lp)), cb));
  }
  return locals.length;
});

// ---------- logs ----------
const lineCount = n => Math.min(Math.max(parseInt(n, 10) || 500, 1), 100000);

ipcMain.handle('logs:read', (_e, connId, file, n) =>
  exec(getConn(connId).conn, `tail -n ${lineCount(n)} -- ${shq(file)}`, true));

// pty so the remote tail gets SIGHUP when we close the channel.
ipcMain.handle('logs:tail', async (_e, connId, file, n) => {
  const stream = await p(cb => getConn(connId).conn.exec(`tail -n ${lineCount(n)} -F -- ${shq(file)}`, { pty: true }, cb));
  const id = crypto.randomUUID();
  const decoder = new StringDecoder('utf8');
  tails.set(id, stream);
  stream.on('data', d => send('logs:data', id, decoder.write(d)));
  stream.on('close', () => { tails.delete(id); send('logs:end', id); });
  return id;
});
ipcMain.on('logs:stop', (_e, id) => tails.get(id)?.close());

// ---------- AI (suggest only; never executes) ----------
const SYSTEM = `You turn a sysadmin's plain-English request into ONE shell command for the given server.
Reply with ONLY a JSON object: {"command": string, "explanation": string, "risk": "low"|"medium"|"high"}.
"risk" is high if the command deletes data, changes users/permissions/firewall, restarts services, or reboots.
Prefer read-only commands when the request allows it. Never chain unrelated actions.`;

ipcMain.handle('ai:suggest', async (_e, connId, request) => {
  const key = apiKey();
  if (!key) throw new Error('No Anthropic API key. Set ANTHROPIC_API_KEY or add one in Settings.');
  const uname = conns.get(connId)?.uname || 'unknown Linux';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL, max_tokens: 1024, system: SYSTEM,
      messages: [{ role: 'user', content: `Server: ${uname}\nRequest: ${request}` }],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message || `API error ${res.status}`);
  const text = body.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  if (typeof json.command !== 'string' || !json.command.trim()) throw new Error('Model returned no command');
  return { command: json.command, explanation: String(json.explanation || ''), risk: String(json.risk || 'unknown') };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { for (const c of conns.values()) c.conn.end(); app.quit(); });
