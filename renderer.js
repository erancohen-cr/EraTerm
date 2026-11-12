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

// ================= home: server list =================
let servers = [];
let favOnly = false;

async function refreshServers() {
  servers = await api.servers.list();
  renderServers();
}

function renderServers() {
  const q = $('#filter').value.toLowerCase();
  const rows = servers
    .filter(s => !favOnly || s.starred)
    .filter(s => !q || [s.name, s.host, s.username, ...s.tags].some(x => x.toLowerCase().includes(q)))
    .sort((a, b) => b.starred - a.starred || a.name.localeCompare(b.name));
  $('#countBadge').textContent = `${rows.length} server${rows.length === 1 ? '' : 's'}`;
  $('#navCount').textContent = servers.length;
  $('#homeTitle').textContent = favOnly ? 'Favorites' : 'All Servers';
  $('#serverRows').replaceChildren(...rows.map(s => {
    const tr = el('tr', {},
      el('td', {}, el('span', { className: 'dot' + (views.has(s.id) ? ' on' : '') }), el('b', { textContent: s.name })),
      el('td', { className: 'mono', textContent: `${s.username}@${s.host}` + (s.port !== 22 ? `:${s.port}` : '') }),
      el('td', {}, ...s.tags.map(t => el('span', { className: 'tag', textContent: t }))),
      el('td', { className: 'muted', textContent: ago(s.lastSeen) }),
      el('td', { className: 'r actions' },
        iconBtn(s.starred ? '★' : '☆', s.starred ? 'Unfavorite' : 'Favorite', () => toggleStar(s), 'icon' + (s.starred ? ' star' : '')),
        iconBtn('✎', 'Edit', () => editServer(s)),
        iconBtn('🗑', 'Delete', () => deleteServer(s), 'icon danger'),
        iconBtn(views.has(s.id) ? '↗ Open' : '▶ Connect', 'Connect', () => openServer(s), 'primary')));
    tr.ondblclick = () => openServer(s);
    return tr;
  }));
  $('#emptyHome').hidden = servers.length > 0;
}

async function toggleStar(s) {
  await api.servers.save({ ...s, starred: !s.starred });
  refreshServers();
}

function editServer(s = {}) {
  const f = $('#serverForm');
  f.reset();
  for (const k of ['id', 'name', 'host', 'port', 'username', 'keyPath']) if (s[k] != null) f.elements[k].value = s[k];
  f.elements.tags.value = (s.tags || []).join(', ');
  f.elements.starred.checked = !!s.starred;
  $('#serverDlg').returnValue = ''; // Esc must not reuse the last 'save'
  $('#serverDlg').showModal();
}

$('#serverDlg').addEventListener('close', async () => {
  if ($('#serverDlg').returnValue !== 'save') return;
  const e = $('#serverForm').elements;
  await api.servers.save({
    id: e.id.value || undefined, name: e.name.value, host: e.host.value, port: e.port.value,
    username: e.username.value, keyPath: e.keyPath.value.trim(), password: e.password.value,
    tags: e.tags.value.split(',').map(t => t.trim()).filter(Boolean), starred: e.starred.checked,
  });
  refreshServers();
});

async function deleteServer(s) {
  if (!confirm(`Delete ${s.name}? Its saved password and host key are removed too.`)) return;
  if (views.has(s.id)) closeServer(s.id);
  await api.servers.delete(s.id);
  refreshServers();
}

$('#addBtn').onclick = () => editServer();
$('#filter').oninput = renderServers;
$('#navAll').onclick = () => { favOnly = false; $('#navAll').classList.add('active'); $('#navFav').classList.remove('active'); renderServers(); };
$('#navFav').onclick = () => { favOnly = true; $('#navFav').classList.add('active'); $('#navAll').classList.remove('active'); renderServers(); };

// ================= settings =================
$('#settingsBtn').onclick = async () => {
  const st = await api.settings.get();
  $('#keyStatus').textContent = st.fromEnv ? 'Using ANTHROPIC_API_KEY from the environment.'
    : st.hasApiKey ? 'An API key is saved (encrypted in Keychain).' : 'No API key set.';
  $('#settingsForm').reset();
  $('#settingsDlg').returnValue = '';
  $('#settingsDlg').showModal();
};
$('#settingsDlg').addEventListener('close', () => {
  const k = $('#settingsForm').elements.apiKey.value.trim();
  if ($('#settingsDlg').returnValue === 'save' && k) api.settings.setApiKey(k);
});

// ================= terminals =================
const shellsById = new Map(); // shellId -> terminal wrapper
api.ssh.onData((id, d) => shellsById.get(id)?.term.write(d));
api.ssh.onClosed(id => {
  shellsById.get(id)?.term.writeln('\r\n\x1b[90m[session closed]\x1b[0m');
  shellsById.delete(id);
});

function makeTerm(host, connId, cwd) {
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, monospace',
    theme: { background: '#0b0d10', cursor: '#3ddc5f', selectionBackground: '#3ddc5f55' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const t = { term, id: null };
  const refit = () => { if (host.offsetParent) fit.fit(); };
  const ro = new ResizeObserver(refit); // handles window resize and hidden->shown
  ro.observe(host);
  refit();
  t.ready = api.ssh.shell(connId, term.cols, term.rows, cwd).then(id => {
    t.id = id;
    shellsById.set(id, t);
    term.onData(d => api.ssh.write(id, d));
    term.onResize(({ cols, rows }) => api.ssh.resize(id, cols, rows));
    api.ssh.resize(id, term.cols, term.rows); // size may have changed while the shell was opening
  }, e => term.writeln(`\x1b[31m${cleanErr(e)}\x1b[0m`));
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
  q('.back').onclick = () => show('home');
  const setStatus = (text, cls) => { q('.status').textContent = text; q('.status').className = 'status ' + cls; };

  // ---- side menu ----
  let mainTerm = null;
  function pickPanel(name) {
    v.panel = name;
    root.querySelectorAll('.panel').forEach(p => (p.hidden = !p.classList.contains(name)));
    root.querySelectorAll('.srvbody > .side .navitem').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    if (!v.connId) return;
    if (name === 'term') {
      mainTerm ||= makeTerm(q('.xhost.main'), v.connId);
      requestAnimationFrame(() => mainTerm.term.focus());
    }
    if (name === 'files' && !fm.loaded) loadDir('');
  }
  root.querySelectorAll('.srvbody > .side .navitem').forEach(b => (b.onclick = () => pickPanel(b.dataset.panel)));

  async function openInTerminal(dir) {
    pickPanel('term');
    await mainTerm.ready;
    if (mainTerm.id) api.ssh.write(mainTerm.id, `cd ${shq(dir)}\r`);
  }

  // ---- side terminal (inside file manager) ----
  let sideTerm = null;
  function openSide(dir) {
    sideTerm?.dispose();
    q('.sidepane').hidden = false;
    q('.sidetitle').textContent = dir;
    sideTerm = makeTerm(q('.sidepane .xhost'), v.connId, dir);
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
    if (!cmd || !mainTerm?.id) return;
    api.ssh.write(mainTerm.id, cmd + '\r');
    q('.aiResult').hidden = true;
    q('.aiInput').value = '';
    mainTerm.term.focus();
  };
  q('.aiCancel').onclick = () => { q('.aiResult').hidden = true; };

  // ---- metrics ----
  const gb = n => (n / 1e9).toFixed(1) + 'G';
  v.pollMetrics = async () => {
    try {
      const m = await api.ssh.metrics(v.connId);
      q('.mCpu').textContent = m.cpu == null ? '—' : m.cpu + '%';
      if (m.memTotal) q('.mMem').textContent = `${gb(m.memUsed)}/${gb(m.memTotal)}`;
      if (m.diskTotal) {
        q('.mDisk').textContent = `${gb(m.diskUsed)}/${gb(m.diskTotal)}`;
        q('.fdisk').textContent = `Disk ${gb(m.diskUsed)} / ${gb(m.diskTotal)} (${Math.round(m.diskUsed / m.diskTotal * 100)}%)`;
      }
    } catch { /* non-Linux server: leave dashes */ }
  };

  // ---- lifecycle ----
  v.onShow = () => { if (v.panel === 'term') mainTerm?.term.focus(); };
  v.disconnected = msg => {
    v.connId = null;
    stopTail();
    setStatus('DISCONNECTED — click to reconnect', 'err');
    if (msg) toast(`${s.name}: ${msg}`, true);
  };
  v.dispose = () => {
    stopTail();
    sideTerm?.dispose();
    mainTerm?.dispose();
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
