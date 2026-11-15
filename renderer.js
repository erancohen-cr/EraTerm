/* global api, Terminal, FitAddon, shq, logLevel */
const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== ''));
  return e;
};
const iconBtn = (text, title, fn, cls = 'icon') =>
  el('button', { className: cls, title, textContent: text, onclick: e => { e.stopPropagation(); fn(); } });
const cleanErr = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const ago = t => {
  if (!t) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
};
const fmtSize = n => {
  if (n == null) return '—';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
};
const basename = p => p.replace(/\/+$/, '').split('/').pop() || '/';
const dirname = p => p.replace(/\/[^/]*\/?$/, '') || '/';

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 3000);
}

// Electron has no window.prompt(); tiny dialog instead.
function askName(title) {
  const dlg = $('#nameDlg');
  $('#nameTitle').textContent = title;
  $('#nameForm').reset();
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () =>
    resolve(dlg.returnValue === 'ok' ? $('#nameForm').elements.name.value.trim() : ''), { once: true }));
}

// Dropping a file outside a drop zone must not navigate the window away.
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

// ================= top tabs =================
const views = new Map(); // serverId -> server view
let deploys; // home Deployments panel, built on first visit

function show(id) {
  $('#home').hidden = id !== 'home';
  $('#homeTab').classList.toggle('active', id === 'home');
  for (const [sid, v] of views) {
    v.root.hidden = sid !== id;
    v.tabEl.classList.toggle('active', sid === id);
  }
  if (id === 'home') refreshServers();
  else views.get(id)?.onShow();
}
$('#homeTab').onclick = () => show('home');

// ================= home: servers, groups, users =================
let servers = [], users = [];
let homeMode = 'all'; // 'all' | 'fav' | 'users' | 'group:<name>'
const UNGROUPED = 'Ungrouped';
const groupOf = s => s.group || UNGROUPED;
const modeGroup = () => (homeMode.startsWith('group:') ? homeMode.slice(6) : null);
let collapsed = new Set();
try { collapsed = new Set(JSON.parse(localStorage.getItem('collapsedGroups')) || []); } catch { /* start expanded */ }
const saveCollapsed = () => { try { localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed])); } catch { /* ignore */ } };

async function refreshServers() {
  [servers, users] = await Promise.all([api.servers.list(), api.users.list()]);
  renderNav();
  renderServers();
  renderUsers();
}

function groupNames() {
  const named = [...new Set(servers.map(s => s.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return servers.some(s => !s.group) ? [...named, UNGROUPED] : named;
}

function setMode(mode) {
  homeMode = mode;
  const g = modeGroup();
  if (g) { collapsed.delete(g); saveCollapsed(); }
  renderNav();
  renderServers();
  $('.content').scrollTop = 0;
}

function renderNav() {
  const g = modeGroup();
  $('#navCount').textContent = servers.length;
  $('#favCount').textContent = servers.filter(s => s.starred).length || '';
  $('#userCount').textContent = users.length || '';
  $('#navAll').classList.toggle('active', homeMode === 'all');
  $('#navFav').classList.toggle('active', homeMode === 'fav');
  $('#navUsers').classList.toggle('active', homeMode === 'users');
  $('#navDeploy').classList.toggle('active', homeMode === 'deploy');
  $('#navGroups').replaceChildren(...groupNames().map(name => el('button', {
    className: 'navitem' + (g === name ? ' active' : ''), title: name, onclick: () => setMode('group:' + name),
  }, el('i', { textContent: name === UNGROUPED ? '◌' : '▣' }), el('span', { className: 'lbl', textContent: name }),
  el('span', { className: 'count lbl', textContent: servers.filter(s => groupOf(s) === name).length }))));
  $('#serversView').hidden = homeMode === 'users' || homeMode === 'deploy';
  $('#usersView').hidden = homeMode !== 'users';
  $('#deployView').hidden = homeMode !== 'deploy';
  $('#home .content').classList.toggle('flush', homeMode === 'deploy');
  if (homeMode === 'deploy') deploys ||= initDeployments($('#deployView .panel'));
  // suggestions for the server form
  $('#groupList').replaceChildren(...groupNames().filter(x => x !== UNGROUPED).map(value => el('option', { value })));
  $('#usernameList').replaceChildren(...users.map(u => el('option', { value: u.username, label: u.label })));
}

function serverRow(s) {
  const tr = el('tr', { className: 'srow' },
    el('td', {}, el('span', { className: 'dot' + (views.has(s.id) ? ' on' : '') }), el('b', { textContent: s.name })),
    el('td', {}, el('span', { className: 'proto ' + typeOf(s), textContent: typeOf(s).toUpperCase() })),
    el('td', { className: 'mono', title: s.userLabel ? `Login: saved user "${s.userLabel}"` : '' },
      `${s.username ? s.username + '@' : ''}${s.host}` + (s.port !== defaultPort(s) ? `:${s.port}` : ''),
      s.userLabel ? el('span', { className: 'ulink', textContent: ' 👤' }) : null),
    el('td', {}, ...s.tags.map(t => el('span', { className: 'tag', textContent: t }))),
    el('td', { className: 'details muted', textContent: s.details || '', title: s.details || '' }),
    el('td', { className: 'muted', textContent: ago(s.lastSeen) }),
    el('td', { className: 'r actions' },
      iconBtn(s.starred ? '★' : '☆', s.starred ? 'Unfavorite' : 'Favorite', () => toggleStar(s), 'icon' + (s.starred ? ' star' : '')),
      iconBtn('✎', 'Edit', () => editServer(s)),
      iconBtn('🗑', 'Delete', () => deleteServer(s), 'icon danger'),
      typeOf(s) === 'ssh' ? iconBtn(...(DESKTOP[s.os] || DESKTOP['']), () => openDesktop(s), 'desk') : el('span', { className: 'desk ph' }), // ph keeps columns aligned
      iconBtn(views.has(s.id) ? '↗ Open' : '▶ Connect', 'Connect', () => connectServer(s), 'primary')));
  tr.ondblclick = () => connectServer(s);
  return tr;
}

function renderServers() {
  const q = $('#filter').value.toLowerCase();
  const g = modeGroup();
  const list = servers
    .filter(s => homeMode !== 'fav' || s.starred)
    .filter(s => !g || groupOf(s) === g)
    .filter(s => !q || [s.name, s.host, s.username, s.group || '', s.details || '', ...s.tags].some(x => x.toLowerCase().includes(q)))
    .sort((a, b) => b.starred - a.starred || a.name.localeCompare(b.name));
  $('#countBadge').textContent = `${list.length} server${list.length === 1 ? '' : 's'}`;
  $('#homeTitle').textContent = g || (homeMode === 'fav' ? 'Favorites' : 'All Servers');
  const rows = [];
  for (const name of groupNames()) {
    const members = list.filter(s => groupOf(s) === name);
    if (!members.length) continue;
    const shut = !q && collapsed.has(name); // searching always shows matches
    rows.push(el('tr', {
      className: 'grprow' + (shut ? ' shut' : ''),
      onclick: () => { collapsed[collapsed.has(name) ? 'delete' : 'add'](name); saveCollapsed(); renderServers(); },
    }, el('td', { colSpan: 7 },
      el('span', { className: 'caret', textContent: shut ? '▸' : '▾' }),
      el('b', { textContent: name }),
      el('span', { className: 'count', textContent: members.length }),
      el('span', { className: 'grow' }),
      iconBtn('＋', `Add a server to ${name}`, () => editServer({ group: name === UNGROUPED ? '' : name })))));
    if (!shut) rows.push(...members.map(serverRow));
  }
  $('#serverRows').replaceChildren(...rows);
  $('#emptyHome').hidden = servers.length > 0;
}
$('#collapseAll').onclick = () => { collapsed = new Set(groupNames()); saveCollapsed(); renderServers(); };
$('#expandAll').onclick = () => { collapsed.clear(); saveCollapsed(); renderServers(); };

const typeOf = s => (s.type === 'rdp' ? 'rdp' : 'ssh');
const defaultPort = s => (typeOf(s) === 'rdp' ? 3389 : 22);

function connectServer(s) {
  return typeOf(s) === 'rdp' ? openRdp(s) : openServer(s);
}

async function openRdp(s) {
  try {
    const r = await api.rdp.open(s.id);
    toast(`Opening ${s.name} in Windows App…` + (r.copied ? ' Password copied to clipboard (cleared in 45 s).' : ''));
    refreshServers();
  } catch (e) { toast(cleanErr(e), true); }
}

// Desktop button for SSH servers, by the server's OS (unknown until the first connection).
const DESKTOP = {
  windows: ['🖥 RDP', 'Open with Remote Desktop (Windows App, port 3389)'],
  macos: ['🖥 Screen Sharing', 'Open with macOS Screen Sharing (Remote Management must be on)'],
  linux: ['🖥 VNC', 'Open the desktop with Screen Sharing (needs a VNC server on port 5900)'],
  unix: ['🖥 VNC', 'Open the desktop with Screen Sharing (needs a VNC server on port 5900)'],
  '': ['🖥 Desktop', 'Open the remote desktop: RDP for Windows, Screen Sharing for macOS/Linux (detects the OS over SSH)'],
};
async function openDesktop(s) {
  if (!s.os) toast(`Detecting the OS of ${s.name}…`);
  try {
    const r = await api.remote.open(s.id);
    toast(`Opening ${s.name} in ${r.os === 'windows' ? 'Windows App' : 'Screen Sharing'}…` +
      (r.copied ? ' Password copied to clipboard (cleared in 45 s).' : ''));
    refreshServers();
  } catch (e) { toast(cleanErr(e), true); }
}

async function toggleStar(s) {
  await api.servers.save({ ...s, starred: !s.starred });
  refreshServers();
}

function editServer(s = {}) {
  const f = $('#serverForm');
  f.reset();
  for (const k of ['id', 'name', 'host', 'port', 'username', 'keyPath', 'group']) if (s[k] != null) f.elements[k].value = s[k];
  f.elements.type.value = typeOf(s);
  f.elements.domain.value = s.domain || '';
  f.elements.userId.replaceChildren(el('option', { value: '', textContent: 'Enter username / password below' }),
    ...users.map(u => el('option', { value: u.id, textContent: `Saved user: ${u.label} (${u.username})` })));
  f.elements.userId.value = s.userId || '';
  syncFormType();
  f.elements.tags.value = (s.tags || []).join(', ');
  f.elements.details.value = s.details || '';
  f.elements.starred.checked = !!s.starred;
  $('#serverDlg').returnValue = ''; // Esc must not reuse the last 'save'
  $('#serverDlg').showModal();
}

// Show only the fields that apply; swap the default port when the type changes.
function syncFormType() {
  const f = $('#serverForm');
  const rdp = f.elements.type.value === 'rdp';
  const saved = !!f.elements.userId.value;
  f.querySelectorAll('.rdp-only').forEach(x => (x.hidden = !rdp));
  f.querySelectorAll('.ssh-only').forEach(x => (x.hidden = rdp));
  f.querySelectorAll('.own-cred').forEach(x => (x.hidden = saved || (rdp && x.classList.contains('ssh-only'))));
  f.querySelector('.saved-user').hidden = !saved;
  f.elements.username.required = !rdp && !saved; // RDP can prompt for the user
  const port = f.elements.port;
  if (rdp && port.value === '22') port.value = '3389';
  if (!rdp && port.value === '3389') port.value = '22';
}
$('#serverForm').elements.type.onchange = syncFormType;
$('#serverForm').elements.userId.onchange = syncFormType;
// Picking a suggested username that belongs to a saved user links that user (and its password).
$('#serverForm').elements.username.onchange = () => {
  const f = $('#serverForm');
  const u = users.find(x => x.username === f.elements.username.value);
  if (u && users.filter(x => x.username === u.username).length === 1) { f.elements.userId.value = u.id; syncFormType(); }
};

$('#serverDlg').addEventListener('close', async () => {
  if ($('#serverDlg').returnValue !== 'save') return;
  const e = $('#serverForm').elements;
  await api.servers.save({
    id: e.id.value || undefined, type: e.type.value, domain: e.domain.value.trim(),
    name: e.name.value, host: e.host.value, port: e.port.value, group: e.group.value, userId: e.userId.value,
    username: e.username.value, keyPath: e.keyPath.value.trim(), password: e.userId.value ? '' : e.password.value,
    tags: e.tags.value.split(',').map(t => t.trim()).filter(Boolean), starred: e.starred.checked,
    details: e.details.value,
  });
  refreshServers();
});

async function deleteServer(s) {
  if (!confirm(`Delete ${s.name}? Its saved password and host key are removed too.`)) return;
  if (views.has(s.id)) closeServer(s.id);
  await api.servers.delete(s.id);
  refreshServers();
}

$('#addBtn').onclick = () => editServer({ group: modeGroup() && modeGroup() !== UNGROUPED ? modeGroup() : '' });
$('#filter').oninput = renderServers;
$('#navAll').onclick = () => setMode('all');
$('#navFav').onclick = () => setMode('fav');
$('#navUsers').onclick = () => setMode('users');
$('#navDeploy').onclick = () => setMode('deploy');

// ---- users (saved credentials) ----
function renderUsers() {
  $('#usersBadge').textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;
  $('#emptyUsers').hidden = users.length > 0;
  $('#userRows').replaceChildren(...users.map(u => {
    const usedBy = servers.filter(x => x.userId === u.id).map(x => x.name);
    return el('tr', {},
      el('td', {}, el('b', { textContent: u.label })),
      el('td', { className: 'mono', textContent: u.username }),
      el('td', {}, ...[u.hasPassword && 'Password', u.keyPath && 'Key'].filter(Boolean).map(t => el('span', { className: 'tag', textContent: t })),
        !u.hasPassword && !u.keyPath ? el('span', { className: 'muted', textContent: 'SSH agent / prompt' }) : null),
      el('td', { className: 'muted', textContent: usedBy.join(', ') || '—', title: usedBy.join('\n') }),
      el('td', { className: 'r actions' },
        iconBtn('✎', 'Edit', () => editUser(u)),
        iconBtn('🗑', 'Delete', () => deleteUser(u, usedBy), 'icon danger')));
  }));
}

function editUser(u = {}) {
  const f = $('#userForm');
  f.reset();
  for (const k of ['id', 'label', 'username', 'keyPath']) f.elements[k].value = u[k] || '';
  f.elements.password.placeholder = u.hasPassword ? 'leave blank to keep the saved one' : 'optional';
  f.elements.clearPassword.parentElement.hidden = !u.hasPassword;
  $('#userDlg').returnValue = '';
  $('#userDlg').showModal();
}
$('#userDlg').addEventListener('close', async () => {
  if ($('#userDlg').returnValue !== 'save') return;
  const e = $('#userForm').elements;
  try {
    await api.users.save({
      id: e.id.value || undefined, label: e.label.value, username: e.username.value,
      password: e.password.value, keyPath: e.keyPath.value, clearPassword: e.clearPassword.checked,
    });
  } catch (err) { toast(cleanErr(err), true); }
  refreshServers();
});
async function deleteUser(u, usedBy) {
  const msg = usedBy.length
    ? `Delete user "${u.label}"? ${usedBy.length} server(s) use it (${usedBy.join(', ')}) and will need their own login.`
    : `Delete user "${u.label}"?`;
  if (!confirm(msg)) return;
  await api.users.delete(u.id);
  refreshServers();
}
$('#addUserBtn').onclick = () => editUser();

// ================= theme =================
// ponytail: theme lives in localStorage (per-machine UI preference); falls back to System if storage is unavailable.
const darkMq = matchMedia('(prefers-color-scheme: dark)');
const allTerms = new Set(); // every xterm, so a theme switch restyles open sessions too
const getThemePref = () => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } };
const isLight = () => document.documentElement.dataset.theme === 'light';
const termTheme = () => (isLight()
  ? { background: '#ffffff', foreground: '#1d2127', cursor: '#1a9a3a', cursorAccent: '#ffffff', selectionBackground: '#1a9a3a40' }
  : { background: '#0b0d10', foreground: '#e3e6eb', cursor: '#3ddc5f', cursorAccent: '#0b0d10', selectionBackground: '#3ddc5f55' });
function applyTheme() {
  const pref = getThemePref();
  document.documentElement.dataset.theme = pref === 'system' ? (darkMq.matches ? 'dark' : 'light') : pref;
  for (const term of allTerms) {
    if (term.element?.isConnected) term.options.theme = termTheme();
    else allTerms.delete(term); // disposed / closed
  }
}
darkMq.addEventListener('change', applyTheme);
applyTheme();

// ================= settings =================
$('#settingsBtn').onclick = async () => {
  const st = await api.settings.get();
  $('#keyStatus').textContent = st.fromEnv ? 'Using ANTHROPIC_API_KEY from the environment.'
    : st.hasApiKey ? 'An API key is saved (encrypted in Keychain).' : 'No API key set.';
  $('#settingsForm').reset();
  $('#settingsForm').elements.theme.value = getThemePref();
  $('#settingsDlg').returnValue = '';
  $('#settingsDlg').showModal();
};
// Preview the theme while the dialog is open; Cancel/Esc restores the saved one.
$('#settingsForm').elements.theme.onchange = e => { document.documentElement.dataset.theme =
  e.target.value === 'system' ? (darkMq.matches ? 'dark' : 'light') : e.target.value; };
$('#settingsDlg').addEventListener('close', () => {
  const f = $('#settingsForm').elements;
  if ($('#settingsDlg').returnValue === 'save') {
    try { localStorage.setItem('theme', f.theme.value); } catch { /* ignore */ }
    const k = f.apiKey.value.trim();
    if (k) api.settings.setApiKey(k);
  }
  applyTheme();
});

// ================= terminals =================
const shellsById = new Map(); // shellId -> terminal wrapper
api.ssh.onData((id, d) => shellsById.get(id)?.term.write(d));
api.ssh.onClosed(id => {
  shellsById.get(id)?.term.writeln('\r\n\x1b[90m[session closed]\x1b[0m');
  shellsById.delete(id);
});

// ---- command suggestions: per-server history (this browser only) + common commands ----
const COMMON_CMDS = [
  'ls -la', 'ls -lah', 'cd ..', 'pwd', 'df -h', 'du -sh *', 'free -h', 'top', 'htop', 'uptime', 'whoami', 'uname -a',
  'ps aux', 'ps aux | grep ', 'kill -9 ', 'tail -f ', 'tail -n 100 ', 'less ', 'cat ', 'grep -rn ', 'find . -name ',
  'systemctl status ', 'systemctl restart ', 'journalctl -xe', 'journalctl -u ', 'sudo -i', 'sudo ',
  'docker ps', 'docker ps -a', 'docker logs -f ', 'docker exec -it ', 'docker compose up -d', 'docker compose logs -f',
  'ss -tulpn', 'netstat -an', 'ip addr', 'ping ', 'curl -I ', 'git status', 'git log --oneline -20', 'git pull',
  'chmod +x ', 'chown -R ', 'mkdir -p ', 'rm -rf ', 'cp -r ', 'mv ', 'tar czf ', 'tar xzf ', 'history | tail -50', 'clear', 'exit',
];
const HIST_MAX = 500;
const histCache = new Map();
function getHist(serverId) {
  if (!histCache.has(serverId)) {
    let h = [];
    try { h = JSON.parse(localStorage.getItem('hist:' + serverId)) || []; } catch { /* no storage: session-only history */ }
    histCache.set(serverId, h);
  }
  return histCache.get(serverId);
}
function pushHist(serverId, cmd) {
  const h = [cmd, ...getHist(serverId).filter(x => x !== cmd)].slice(0, HIST_MAX);
  histCache.set(serverId, h);
  try { localStorage.setItem('hist:' + serverId, JSON.stringify(h)); } catch { /* ignore */ }
}

function makeTerm(host, connId, cwd, serverId) {
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, monospace',
    theme: termTheme(),
  });
  allTerms.add(term);
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const t = { term, id: null };
  const refit = () => { if (host.offsetParent) fit.fit(); };
  const ro = new ResizeObserver(refit); // handles window resize and hidden->shown
  ro.observe(host);
  refit();

  // We only know what the user typed since the last Enter; anything that moves the cursor
  // (arrows, shell Tab-completion, Ctrl-keys) makes that unknowable, so tracking stops until Enter.
  // Suggestions show only when the screen line really ends with what we tracked: that also hides
  // them at password prompts (no echo), and keeps unechoed input out of history.
  const sug = { line: '', lost: false, echoed: false, items: [], idx: 0, box: el('div', { className: 'suggest', hidden: true }) };
  host.append(sug.box);
  const cursorLine = () => {
    const b = term.buffer.active;
    return b.getLine(b.baseY + b.cursorY)?.translateToString(true) || '';
  };
  const hide = () => { sug.box.hidden = true; sug.items = []; };
  function refresh() {
    const typed = sug.line;
    if (sug.lost || typed.trim().length < 1 || term.buffer.active.type === 'alternate') return hide();
    if (!cursorLine().trimEnd().endsWith(typed.trimEnd())) return hide();
    sug.echoed = true; // the shell echoes this line, so it's not a password prompt
    const seen = new Set();
    sug.items = [...getHist(serverId), ...COMMON_CMDS]
      .filter(c => c.startsWith(typed) && c !== typed && !seen.has(c) && seen.add(c))
      .slice(0, 6);
    if (!sug.items.length) return hide();
    sug.idx = 0;
    render();
  }
  function render() {
    sug.box.replaceChildren(
      ...sug.items.map((c, i) => el('div', {
        className: 'sitem' + (i === sug.idx ? ' active' : ''),
        onmousedown: e => { e.preventDefault(); sug.idx = i; accept(); },
      }, el('b', { textContent: sug.line }), el('span', { textContent: c.slice(sug.line.length) }))),
      el('div', { className: 'shint', textContent: 'Tab accept · ↑↓ choose · Esc close' }));
    sug.box.hidden = false;
    // place under (or above, near the bottom) the start of the typed text
    const screen = term.element.querySelector('.xterm-screen');
    const hr = host.getBoundingClientRect(), sr = screen.getBoundingClientRect();
    const cw = sr.width / term.cols, ch = sr.height / term.rows;
    const b = term.buffer.active;
    sug.box.style.left = `${sr.left - hr.left + Math.max(0, b.cursorX - sug.line.length) * cw}px`;
    const y = sr.top - hr.top + b.cursorY * ch;
    if (b.cursorY > term.rows / 2) { sug.box.style.top = ''; sug.box.style.bottom = `${hr.height - y + 2}px`; }
    else { sug.box.style.bottom = ''; sug.box.style.top = `${y + ch + 2}px`; }
  }
  function accept() {
    const rest = sug.items[sug.idx]?.slice(sug.line.length);
    if (rest && t.id) { api.ssh.write(t.id, rest); sug.line += rest; }
    hide();
  }
  function track(d) {
    if (d === '\r') {
      const cmd = sug.line.trim();
      if (cmd && !sug.lost) {
        if (sug.echoed) pushHist(serverId, cmd);
        else { // Enter beat the echo (paste + Enter, slow link): look at that screen row once it's drawn
          const b = term.buffer.active, row = b.baseY + b.cursorY;
          setTimeout(() => { if (b.getLine(row)?.translateToString(true).includes(cmd)) pushHist(serverId, cmd); }, 500);
        }
      }
      sug.line = ''; sug.lost = false; sug.echoed = false;
      return hide();
    }
    if (d === '\x7f' || d === '\b') sug.line = sug.line.slice(0, -1);
    else if (d === '\x03' || d === '\x15') { sug.line = ''; sug.lost = false; sug.echoed = false; } // Ctrl-C / Ctrl-U clear the line
    else if (/^[^\x00-\x1f\x7f]+$/.test(d)) sug.line += d;                    // typed or pasted text
    else { sug.lost = true; return hide(); }                                  // arrows, Tab, other control keys
    setTimeout(refresh); // in case the echo was already drawn before we updated the line
  }
  term.attachCustomKeyEventHandler(e => {
    if (sug.box.hidden || e.type !== 'keydown') return true;
    if (e.key === 'Tab') { e.preventDefault(); accept(); return false; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      sug.idx = (sug.idx + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
      render();
      return false;
    }
    if (e.key === 'Escape') { hide(); return false; }
    return true;
  });
  term.onWriteParsed(() => { if (sug.line) refresh(); }); // re-check after the shell echoes
  term.onScroll(hide);

  t.ready = api.ssh.shell(connId, term.cols, term.rows, cwd).then(id => {
    t.id = id;
    shellsById.set(id, t);
    term.onData(d => { track(d); api.ssh.write(id, d); }); // track first: Enter must see the line before the echo
    term.onResize(({ cols, rows }) => api.ssh.resize(id, cols, rows));
    api.ssh.resize(id, term.cols, term.rows); // size may have changed while the shell was opening
  }, e => term.writeln(`\x1b[31m${cleanErr(e)}\x1b[0m`));
  t.run = async cmd => { await t.ready; if (t.id) api.ssh.write(t.id, cmd); };
  t.dispose = () => {
    ro.disconnect();
    if (t.id) { api.ssh.closeShell(t.id); shellsById.delete(t.id); }
    term.dispose();
    host.replaceChildren();
  };
  return t;
}

// ================= server page =================
const tailHandlers = new Map(); // tailId -> { data(chunk), end() }
api.logs.onData((id, d) => tailHandlers.get(id)?.data(d));
api.logs.onEnd(id => { tailHandlers.get(id)?.end(); tailHandlers.delete(id); });

api.ssh.onConnClosed((connId, msg) => {
  for (const v of views.values()) if (v.connId === connId) v.disconnected(msg);
});

function closeServer(serverId) {
  const v = views.get(serverId);
  if (!v) return;
  v.dispose();
  views.delete(serverId);
  show('home');
}

async function openServer(s) {
  if (views.has(s.id)) return show(s.id);

  const root = $('#serverTpl').content.firstElementChild.cloneNode(true);
  const q = sel => root.querySelector(sel);
  $('#views').append(root);
  const tabEl = el('button', { className: 'tab', onclick: () => show(s.id) },
    el('span', { textContent: '▤ ' + s.name }),
    el('span', { className: 'x', textContent: '×', title: 'Disconnect', onclick: e => { e.stopPropagation(); closeServer(s.id); } }));
  $('#tabs').append(tabEl);

  const v = { root, tabEl, connId: null, panel: 'files' };
  views.set(s.id, v);

  q('.sname').textContent = s.name;
  q('.saddr').textContent = `${s.username}@${s.host}:${s.port}`;
  q('.sdetails').textContent = q('.sdetails').title = s.details || '';
  q('.sdetails').hidden = !s.details;
  q('.back').onclick = () => show('home');
  const setStatus = (text, cls) => { q('.status').textContent = text; q('.status').className = 'status ' + cls; };

  // ---- side menu ----
  function pickPanel(name) {
    v.panel = name;
    root.querySelectorAll('.panel').forEach(p => (p.hidden = !p.classList.contains(name)));
    root.querySelectorAll('.srvbody > .side .navitem').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    if (!v.connId) return;
    if (name === 'term') {
      if (!sessions.length && !v.termOpened) newSession();
      v.termOpened = true;
      requestAnimationFrame(() => active?.t.term.focus());
    }
    if (name === 'files' && !fm.loaded) loadDir('');
  }
  root.querySelectorAll('.srvbody > .side .navitem').forEach(b => (b.onclick = () => pickPanel(b.dataset.panel)));

  // ---- terminal sessions (tabs) ----
  const sessions = [];
  let active = null, sessNo = 0;

  function newSession(cwd) {
    if (!v.connId) return null;
    const host = el('div', { className: 'xhost' });
    q('.thosts').append(host);
    const sess = { host, title: `Session ${++sessNo}` };
    const titleEl = el('span', { className: 'ttitle', textContent: sess.title, title: 'Double-click to rename' });
    titleEl.ondblclick = e => { e.stopPropagation(); renameSession(sess, titleEl); };
    sess.tabEl = el('div', { className: 'ttab', onclick: () => activateSession(sess) },
      el('span', { className: 'tdot' }), titleEl,
      iconBtn('×', 'Close session', () => closeSession(sess), 'x'));
    q('.ttablist').append(sess.tabEl);
    sess.t = makeTerm(host, v.connId, cwd, s.id);
    sessions.push(sess);
    activateSession(sess);
    return sess;
  }

  function activateSession(sess) {
    active = sess;
    for (const x of sessions) {
      x.host.hidden = x !== sess;
      x.tabEl.classList.toggle('active', x === sess);
    }
    q('.tempty').hidden = sessions.length > 0;
    if (sess) requestAnimationFrame(() => sess.t.term.focus());
  }

  function closeSession(sess) {
    sess.t.dispose();
    sess.host.remove();
    sess.tabEl.remove();
    sessions.splice(sessions.indexOf(sess), 1);
    if (active === sess) activateSession(sessions[sessions.length - 1] || null);
    q('.tempty').hidden = sessions.length > 0;
  }

  function renameSession(sess, titleEl) {
    const inp = el('input', { className: 'trename', value: sess.title });
    titleEl.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      if (save && inp.value.trim()) sess.title = inp.value.trim();
      titleEl.textContent = sess.title;
      inp.replaceWith(titleEl);
      sess.t.term.focus();
    };
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
    inp.onclick = e => e.stopPropagation();
  }

  // run text in the active session (open one if none)
  async function runInTerminal(cmd) {
    pickPanel('term');
    const sess = active || newSession();
    if (!sess) return;
    await sess.t.run(cmd);
    sess.t.term.focus();
  }
  const openInTerminal = dir => runInTerminal(`cd ${shq(dir)}\r`);

  q('.tnew').onclick = () => newSession();

  // ---- scripts side panel ----
  let scripts = [], dragId = null;
  const activeTags = new Set(); // show scripts having ANY of these tags
  let sortMode = 'manual';
  try { sortMode = localStorage.getItem('scriptSort') || 'manual'; } catch { /* default */ }
  q('.sc-sort').value = sortMode;
  const lastRun = () => { try { return JSON.parse(localStorage.getItem('scriptLastRun')) || {}; } catch { return {}; } };

  async function loadScripts() {
    try { scripts = await api.scripts.list(); } catch (e) { toast(cleanErr(e), true); }
    renderScripts();
  }
  const toggleTag = t => { activeTags[activeTags.has(t) ? 'delete' : 'add'](t); renderScripts(); };

  function renderTags() {
    const counts = new Map();
    for (const x of scripts) for (const t of x.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    for (const t of activeTags) if (!counts.has(t)) activeTags.delete(t);
    q('.sc-tags').replaceChildren(
      ...[...counts.keys()].sort().map(t => el('button', {
        className: 'tchip' + (activeTags.has(t) ? ' on' : ''), title: `Show scripts tagged "${t}"`, onclick: () => toggleTag(t),
      }, t, el('small', { textContent: counts.get(t) }))),
      ...(activeTags.size ? [el('button', { className: 'tchip clear', textContent: '✕ Clear', onclick: () => { activeTags.clear(); renderScripts(); } })] : []));
  }

  function renderScripts() {
    renderTags();
    const f = q('.sc-filter').value.toLowerCase();
    let list = scripts
      .filter(x => !f || `${x.name} ${x.description} ${x.command} ${(x.tags || []).join(' ')}`.toLowerCase().includes(f))
      .filter(x => !activeTags.size || (x.tags || []).some(t => activeTags.has(t)));
    if (sortMode === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sortMode === 'recent') { const lr = lastRun(); list = [...list].sort((a, b) => (lr[b.id] || 0) - (lr[a.id] || 0)); }
    const canDrag = sortMode === 'manual' && !f && !activeTags.size;
    q('.sc-hint').textContent = sortMode !== 'manual' ? '' : canDrag ? 'Drag ⋮⋮ to change the order.' : 'Clear the search and tag filters to drag scripts into a new order.';
    q('.sc-list').replaceChildren(...list.map(x => {
      const li = el('li', { title: x.command, draggable: canDrag },
        el('div', { className: 'sc-head' },
          canDrag ? el('span', { className: 'grip', textContent: '⋮⋮', title: 'Drag to reorder' }) : null,
          el('b', { textContent: x.name }),
          el('span', { className: 'grow' }),
          iconBtn('✎', 'Edit', () => editScript(x)),
          iconBtn('🗑', 'Delete', () => deleteScript(x), 'icon danger'),
          iconBtn('▶ Run', 'Run in the active terminal session', () => runScript(x), 'primary sm')),
        x.description ? el('small', { textContent: x.description }) : null,
        el('code', { className: 'mono', textContent: x.command.split('\n')[0] + (x.command.includes('\n') ? ' …' : '') }),
        x.tags?.length ? el('div', { className: 'sc-tagrow' }, ...x.tags.map(t => el('span', {
          className: 'tag' + (activeTags.has(t) ? ' on' : ''), textContent: t, title: `Filter by "${t}"`,
          onclick: e => { e.stopPropagation(); toggleTag(t); },
        }))) : null);
      if (canDrag) {
        li.ondragstart = e => { dragId = x.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
        li.ondragend = () => { dragId = null; li.classList.remove('dragging'); };
        li.ondragover = e => {
          if (!dragId) return;
          e.preventDefault();
          const r = li.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          li.classList.toggle('drop-after', after);
          li.classList.toggle('drop-before', !after);
        };
        li.ondragleave = () => li.classList.remove('drop-after', 'drop-before');
        li.ondrop = async e => {
          e.preventDefault();
          const after = li.classList.contains('drop-after');
          li.classList.remove('drop-after', 'drop-before');
          if (!dragId || dragId === x.id) return;
          const ids = scripts.map(y => y.id).filter(id => id !== dragId);
          ids.splice(ids.indexOf(x.id) + (after ? 1 : 0), 0, dragId);
          scripts = ids.map(id => scripts.find(y => y.id === id));
          renderScripts();
          try { await api.scripts.reorder(ids); } catch (err) { toast(cleanErr(err), true); loadScripts(); }
        };
      }
      return li;
    }));
  }
  q('.sc-sort').onchange = () => {
    sortMode = q('.sc-sort').value;
    try { localStorage.setItem('scriptSort', sortMode); } catch { /* ignore */ }
    renderScripts();
  };
  q('.sc-restore').onclick = async () => {
    const n = await api.scripts.restoreBuiltins();
    toast(n ? `Restored ${n} built-in script${n === 1 ? '' : 's'}` : 'All built-in scripts are already in your list.');
    loadScripts();
  };
  function runScript(x) {
    try { localStorage.setItem('scriptLastRun', JSON.stringify({ ...lastRun(), [x.id]: Date.now() })); } catch { /* ignore */ }
    const body = x.command.replace(/\r\n/g, '\n').trimEnd();
    if (!body.includes('\n')) return runInTerminal(body + '\r');
    // multi-line: feed through a heredoc so blocks/functions run as one script
    const interp = body.startsWith('#!') ? body.slice(2, body.indexOf('\n')).trim() : 'sh';
    runInTerminal(`${interp} -s <<'ERATERM_SCRIPT'\r${body.replace(/\n/g, '\r')}\rERATERM_SCRIPT\r`);
  }
  function editScript(x = {}) {
    const f = $('#scriptForm');
    f.reset();
    for (const k of ['id', 'name', 'description', 'command']) f.elements[k].value = x[k] || '';
    f.elements.tags.value = (x.tags || []).join(', ');
    // existing tags as one-click chips
    const all = [...new Set(scripts.flatMap(y => y.tags || []))].sort();
    $('#scriptTagPick').replaceChildren(...all.map(t => el('button', {
      type: 'button', className: 'tchip', textContent: t,
      onclick: () => {
        const cur = f.elements.tags.value.split(',').map(y => y.trim()).filter(Boolean);
        if (!cur.includes(t)) f.elements.tags.value = [...cur, t].join(', ');
      },
    })));
    const dlg = $('#scriptDlg');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'save') return;
      const e = f.elements;
      try {
        await api.scripts.save({ id: e.id.value || undefined, name: e.name.value, description: e.description.value, command: e.command.value, tags: e.tags.value });
        loadScripts();
      } catch (err) { toast(cleanErr(err), true); }
    }, { once: true });
  }
  async function deleteScript(x) {
    if (!confirm(`Delete script "${x.name}"?`)) return;
    await api.scripts.delete(x.id);
    loadScripts();
  }
  q('.tscripts').onclick = () => {
    const p = q('.scripts');
    p.hidden = !p.hidden;
    q('.tscripts').classList.toggle('on', !p.hidden);
    if (!p.hidden) loadScripts();
  };
  q('.sc-close').onclick = () => { q('.scripts').hidden = true; q('.tscripts').classList.remove('on'); };
  q('.sc-refresh').onclick = loadScripts;
  q('.sc-add').onclick = () => editScript();
  q('.sc-filter').oninput = renderScripts;
  q('.sc-up').onclick = async () => {
    try { const n = await api.scripts.import(); if (n) toast(`Imported ${n} script${n === 1 ? '' : 's'}`); loadScripts(); }
    catch (e) { toast(`Import failed: ${cleanErr(e)}`, true); }
  };
  q('.sc-down').onclick = async () => {
    try { const f = await api.scripts.export(); if (f) toast(`Exported to ${f}`); }
    catch (e) { toast(cleanErr(e), true); }
  };

  // ---- side terminal (inside file manager) ----
  let sideTerm = null;
  function openSide(dir) {
    sideTerm?.dispose();
    q('.sidepane').hidden = false;
    q('.sidetitle').textContent = dir;
    sideTerm = makeTerm(q('.sidepane .xhost'), v.connId, dir, s.id);
    requestAnimationFrame(() => sideTerm.term.focus());
  }
  q('.sideclose').onclick = () => { sideTerm?.dispose(); sideTerm = null; q('.sidepane').hidden = true; };

  // ---- file manager ----
  const fm = { path: '', entries: [], loaded: false };
  async function loadDir(dir) {
    try {
      const r = await api.sftp.list(v.connId, dir);
      Object.assign(fm, r, { loaded: true });
      q('.path').value = r.path;
      renderFiles();
    } catch (e) {
      toast(`Cannot open ${dir || 'home'}: ${cleanErr(e)}`, true);
      q('.path').value = fm.path;
    }
  }

  function renderFiles() {
    const term = q('.fsearch').value.toLowerCase();
    const hidden = q('.showhidden').checked;
    const list = fm.entries
      .filter(e => (hidden || !e.name.startsWith('.')) && (!term || e.name.toLowerCase().includes(term)))
      .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    q('.frows').replaceChildren(...list.map(e => {
      const isDir = e.type === 'dir';
      const cwd = isDir ? e.path : fm.path;
      const tr = el('tr', { className: isDir ? 'dir' : '' },
        el('td', { className: 'fname' },
          el('span', { className: 'ficon', textContent: isDir ? '▰' : '▫' }),
          el('span', { textContent: e.name }),
          e.link ? el('small', { className: 'link mono', textContent: `→ ${e.link}` }) : null),
        el('td', { className: 'r muted mono', textContent: isDir ? '—' : fmtSize(e.size) }),
        el('td', { className: 'r muted mono', textContent: ago(e.mtime) }),
        el('td', { className: 'r actions' },
          iconBtn('◧', 'Open in side terminal', () => openSide(cwd)),
          iconBtn('›_', 'Open in terminal', () => openInTerminal(cwd)),
          iconBtn('⧉', 'Copy path', () => navigator.clipboard.writeText(e.path).then(() => toast(`Copied ${e.path}`), err => toast(cleanErr(err), true))),
          iconBtn('⤓', isDir ? 'Download as .tar.gz' : 'Download', () => download(e)),
          iconBtn('🗑', 'Delete', () => remove(e), 'icon danger')));
      tr.ondblclick = () => (isDir ? loadDir(e.path) : download(e));
      return tr;
    }));
    const dirs = list.filter(e => e.type === 'dir').length;
    const bytes = list.reduce((n, e) => n + (e.type === 'dir' ? 0 : e.size || 0), 0);
    q('.fstat').textContent = `${dirs} folders · ${list.length - dirs} files · ${fmtSize(bytes)}`;
  }

  async function download(e) {
    try {
      toast(`Downloading ${e.name}…`);
      const saved = await api.sftp.download(v.connId, e.path, e.type === 'dir');
      if (saved) toast(`Saved to ${saved}`);
    } catch (err) { toast(`Download failed: ${cleanErr(err)}`, true); }
  }

  async function remove(e) {
    if (!confirm(`Delete ${e.path}${e.type === 'dir' ? ' and everything inside it' : ''}? This cannot be undone.`)) return;
    try { await api.sftp.delete(v.connId, e.path); toast(`Deleted ${e.name}`); } catch (err) { toast(`Delete failed: ${cleanErr(err)}`, true); }
    loadDir(fm.path);
  }

  async function upload(locals) {
    try {
      toast('Uploading…');
      const n = await api.sftp.upload(v.connId, fm.path, locals);
      if (n) toast(`Uploaded ${n} item${n === 1 ? '' : 's'} to ${fm.path}`);
    } catch (err) { toast(`Upload failed: ${cleanErr(err)}`, true); }
    loadDir(fm.path);
  }

  q('.up').onclick = () => loadDir(dirname(fm.path));
  q('.homedir').onclick = () => loadDir('');
  q('.refresh').onclick = () => loadDir(fm.path);
  q('.path').onkeydown = e => { if (e.key === 'Enter') loadDir(q('.path').value.trim()); };
  q('.fsearch').oninput = renderFiles;
  q('.showhidden').onchange = renderFiles;
  q('.upload').onclick = () => upload();
  q('.sideterm').onclick = () => openSide(fm.path);
  q('.mkdir').onclick = async () => {
    const name = await askName('New folder name');
    if (!name) return;
    try { await api.sftp.mkdir(v.connId, `${fm.path.replace(/\/$/, '')}/${name}`); } catch (err) { toast(cleanErr(err), true); }
    loadDir(fm.path);
  };

  const drop = q('.droparea');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); };
  drop.ondrop = e => {
    e.preventDefault();
    drop.classList.remove('over');
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    if (paths.length) upload(paths);
  };

  // ---- logs ----
  const lg = { paths: [...(s.logPaths || [])], cur: null, live: false, tailId: null, partial: '', n: 0 };
  const lbody = q('.lbody');

  function renderSources() {
    const f = q('.lfilter').value.toLowerCase();
    q('.lcount').textContent = lg.paths.length;
    q('.llist').replaceChildren(...lg.paths.filter(p => !f || p.toLowerCase().includes(f)).map(p =>
      el('li', { className: p === lg.cur ? 'active' : '', title: p, onclick: () => selectLog(p) },
        el('span', { textContent: '▫ ' + basename(p) }),
        iconBtn('×', 'Remove source', () => removeSource(p)))));
  }
  const saveSources = () => api.servers.setLogPaths(s.id, lg.paths);
  function removeSource(p) {
    lg.paths = lg.paths.filter(x => x !== p);
    saveSources();
    if (lg.cur === p) { stopTail(); lg.cur = null; lbody.replaceChildren(); q('.lname').textContent = 'Select a log source'; q('.lpath').textContent = ''; }
    renderSources();
  }
  q('.ladd').onsubmit = e => {
    e.preventDefault();
    const inp = q('.ladd input');
    const p = inp.value.trim();
    if (!p) return;
    if (!lg.paths.includes(p)) { lg.paths.push(p); saveSources(); }
    inp.value = '';
    selectLog(p);
  };
  q('.lfilter').oninput = renderSources;

  function selectLog(p) {
    lg.cur = p;
    q('.lname').textContent = basename(p);
    q('.lpath').textContent = p;
    renderSources();
    reloadLog();
  }

  function stopTail() {
    if (lg.tailId) { api.logs.stop(lg.tailId); tailHandlers.delete(lg.tailId); lg.tailId = null; }
  }

  function updateLogStat() {
    q('.lstat').textContent = (lg.live ? '● Live · ' : '') + `${lbody.childElementCount} lines`;
    q('.llive').classList.toggle('on', lg.live);
  }

  function applySearch(row) {
    const term = q('.lsearch').value.toLowerCase();
    const match = !!term && row.dataset.text.includes(term);
    if (q('.lmode').value === 'filter') { row.classList.remove('hit'); row.hidden = !!term && !match; }
    else { row.hidden = false; row.classList.toggle('hit', match); }
  }
  const searchAll = () => { for (const r of lbody.children) applySearch(r); };
  q('.lsearch').oninput = searchAll;
  q('.lmode').onchange = searchAll;

  function appendText(chunk) {
    const atBottom = lbody.scrollHeight - lbody.scrollTop - lbody.clientHeight < 40;
    const lines = (lg.partial + chunk.replace(/\r/g, '')).split('\n');
    lg.partial = lines.pop();
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const row = el('div', { className: 'lrow ' + logLevel(line) },
        el('span', { className: 'ln', textContent: ++lg.n }), el('span', { textContent: line }));
      row.dataset.text = line.toLowerCase();
      applySearch(row);
      frag.append(row);
    }
    lbody.append(frag);
    const max = Number(q('.llines').value); // keep the last N lines only
    while (lbody.childElementCount > max) lbody.firstElementChild.remove();
    if (atBottom) lbody.scrollTop = lbody.scrollHeight;
    updateLogStat();
  }

  async function reloadLog() {
    stopTail();
    lbody.replaceChildren();
    lg.partial = ''; lg.n = 0;
    updateLogStat();
    if (!lg.cur || !v.connId) return;
    const n = q('.llines').value;
    const file = lg.cur;
    try {
      if (lg.live) {
        const id = await api.logs.tail(v.connId, file, n);
        if (!lg.live || lg.cur !== file) return api.logs.stop(id); // user changed something meanwhile
        lg.tailId = id;
        tailHandlers.set(id, {
          data: appendText,
          end: () => { if (lg.tailId === id) { lg.tailId = null; lg.live = false; updateLogStat(); } },
        });
      } else {
        appendText(await api.logs.read(v.connId, file, n) + '\n');
      }
    } catch (err) { toast(`${basename(file)}: ${cleanErr(err)}`, true); }
    lbody.scrollTop = lbody.scrollHeight;
  }

  q('.llive').onclick = () => {
    lg.live = !lg.live;
    if (lg.live) reloadLog();
    else { stopTail(); updateLogStat(); } // stopping keeps what's on screen
  };
  q('.llines').onchange = reloadLog;
  q('.lrefresh').onclick = reloadLog;
  q('.lclear').onclick = () => { lbody.replaceChildren(); updateLogStat(); }; // screen only, tail keeps running
  q('.ldl').onclick = () => lg.cur && download({ name: basename(lg.cur), path: lg.cur, type: 'file' });
  renderSources();

  // ---- AI (suggest, show, run only on approval) ----
  q('.aiForm').onsubmit = async e => {
    e.preventDefault();
    const req = q('.aiInput').value.trim();
    if (!req || !v.connId) return;
    q('.aiError').textContent = '';
    q('.aiResult').hidden = true;
    const btn = q('.aiForm button');
    btn.disabled = true; btn.textContent = 'Thinking…';
    try {
      const r = await api.ai.suggest(v.connId, req);
      q('.aiCmd').value = r.command;
      q('.aiExplain').textContent = r.explanation;
      q('.aiRisk').textContent = `risk: ${r.risk}`;
      q('.aiRisk').className = 'aiRisk risk-' + r.risk;
      q('.aiResult').hidden = false;
    } catch (err) {
      q('.aiError').textContent = cleanErr(err);
    } finally {
      btn.disabled = false; btn.textContent = 'Suggest';
    }
  };
  q('.aiApprove').onclick = () => {
    const cmd = q('.aiCmd').value.trim();
    if (!cmd) return;
    runInTerminal(cmd + '\r');
    q('.aiResult').hidden = true;
    q('.aiInput').value = '';
  };
  q('.aiCancel').onclick = () => { q('.aiResult').hidden = true; };

  // ---- metrics ----
  const gb = n => (n / 1e9).toFixed(1) + 'G';
  v.pollMetrics = async () => {
    try {
      const m = await api.ssh.metrics(v.connId);
      const pct = (u, t) => Math.round((u / t) * 100) + '%';
      q('.mCpu').textContent = m.cpu == null ? '—' : m.cpu + '%';
      if (m.memTotal) q('.mMem').textContent = `${pct(m.memUsed, m.memTotal)} (${gb(m.memUsed)}/${gb(m.memTotal)})`;
      if (m.diskTotal) {
        q('.mDisk').textContent = `${pct(m.diskUsed, m.diskTotal)} (${gb(m.diskUsed)}/${gb(m.diskTotal)})`;
        q('.fdisk').textContent = `Disk ${gb(m.diskUsed)} / ${gb(m.diskTotal)} (${pct(m.diskUsed, m.diskTotal)})`;
      }
    } catch { /* unsupported OS (e.g. Windows): leave dashes */ }
  };

  // ---- lifecycle ----
  v.onShow = () => { if (v.panel === 'term') active?.t.term.focus(); };
  v.disconnected = msg => {
    v.connId = null;
    stopTail();
    setStatus('DISCONNECTED — click to reconnect', 'err');
    if (msg) toast(`${s.name}: ${msg}`, true);
  };
  v.dispose = () => {
    stopTail();
    sideTerm?.dispose();
    for (const x of [...sessions]) closeSession(x);
    if (v.connId) api.ssh.disconnect(v.connId);
    v.connId = null;
    root.remove();
    tabEl.remove();
  };
  q('.status').onclick = () => {
    if (v.connId) return;
    closeServer(s.id);
    openServer(servers.find(x => x.id === s.id) || s);
  };

  pickPanel('files');
  show(s.id);
  try {
    v.connId = await api.ssh.connect(s.id);
  } catch (e) {
    setStatus('FAILED — click to retry', 'err');
    toast(`${s.name}: ${cleanErr(e)}`, true);
    return;
  }
  if (!views.has(s.id)) return api.ssh.disconnect(v.connId); // tab closed while connecting
  setStatus('● CONNECTED', 'on');
  pickPanel(v.panel);
  v.pollMetrics();
}

// Poll metrics only for the server page on screen.
setInterval(() => {
  for (const v of views.values()) if (!v.root.hidden && v.connId) v.pollMetrics();
}, 5000);

refreshServers();

// ================= foldable side menus (one state for all menus) =================
const setFolded = on => {
  document.body.classList.toggle('folded', on);
  try { localStorage.setItem('sideFolded', on ? '1' : ''); } catch { /* storage unavailable: just don't remember */ }
};
try { setFolded(localStorage.getItem('sideFolded') === '1'); } catch { /* default: expanded */ }
document.addEventListener('click', e => {
  if (e.target.closest('.fold')) setFolded(!document.body.classList.contains('folded'));
});
