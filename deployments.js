/* global api, el, iconBtn, toast, cleanErr, servers */
// Deployments panel: edit saved deployments, run them on many servers, watch per-server progress.
// Runs happen in main (deploy.js); this file only edits definitions and renders events.

const deployRunHandlers = new Map(); // runId -> event handler
api.deploy.onEvent((runId, ev) => deployRunHandlers.get(runId)?.(ev));

const D_STAGES = [
  ['pre', 'Pre-deploy', 'Runs first: backups, stopping services, sanity checks.'],
  ['files', 'Files', 'Copied to every target server. Folders keep their structure.'],
  ['deploy', 'Deploy', 'Install and configure.'],
  ['post', 'Post-deploy', 'Restart services, smoke tests, cleanup.'],
];
const D_CHECKS = { log: 'Log check', port: 'TCP port', exit: 'Script exit code' };
const D_STATUS = { pending: 'Pending', running: 'Running', success: 'Success', warning: 'Success with alerts', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' };

const newCheck = (type, onFail = 'stop') => ({
  type, onFail, timeout: type === 'exit' ? 0 : 30,
  ...(type === 'log' ? { file: '', pattern: '', expect: 'present', lines: 200 }
    : type === 'port' ? { host: '', port: '' } : { command: '', expectCode: 0 }),
});
const blankDeployment = serverId => ({
  id: null, name: 'New deployment', targets: [serverId], parallel: false, files: [],
  stages: { pre: { commands: [], checks: [] }, deploy: { commands: [], checks: [] }, post: { commands: [], checks: [] } },
});

function initDeployments(panel, server) {
  let list = [], cur = null, dirty = false, lib = [], run = null;
  const listEl = panel.querySelector('.dl');
  const ed = panel.querySelector('.deditor');
  const runsBox = el('section', { className: 'druns', hidden: true }); // survives editor re-renders

  // ---------- list ----------
  async function load(selectId) {
    try { [list, lib] = await Promise.all([api.deploy.list(), api.scripts.list()]); } catch (e) { toast(cleanErr(e), true); }
    const pick = list.find(d => d.id === selectId);
    if (pick) select(pick, true);
    else if (!cur) renderEmpty();
    renderList();
  }
  function renderList() {
    panel.querySelector('.dcount').textContent = list.length;
    listEl.replaceChildren(...list.map(d => el('li', {
      className: d.id === cur?.id ? 'active' : '',
      onclick: () => select(d),
    }, el('b', { textContent: d.name }),
    el('small', { textContent: `${d.targets.length} server${d.targets.length === 1 ? '' : 's'} · ${d.files.length} file${d.files.length === 1 ? '' : 's'}` }))));
  }
  function select(d, force = false) {
    if (!force && dirty && !confirm('Discard unsaved changes?')) return;
    cur = structuredClone(d);
    dirty = false;
    renderEditor();
    renderList();
  }
  function renderEmpty() {
    ed.replaceChildren(el('div', { className: 'empty' },
      el('p', { textContent: 'Push files to one or more servers and run commands around them, with checks between stages.' }),
      el('button', { className: 'primary', textContent: '＋ New deployment', onclick: () => select(blankDeployment(server.id)) })),
    runsBox);
  }
  panel.querySelector('.dnew').onclick = () => select(blankDeployment(server.id));

  // ---------- editor helpers ----------
  const touch = () => { dirty = true; ed.querySelector('.dsave')?.classList.add('dirty'); };
  const rerender = () => { touch(); renderEditor(); };
  function inp(obj, key, attrs = {}, tag = 'input') {
    const e = el(tag, attrs);
    e.value = obj[key] ?? '';
    e.oninput = () => { obj[key] = e.type === 'number' ? (e.value === '' ? '' : Number(e.value)) : e.value; touch(); };
    return e;
  }
  function sel(obj, key, options, after) {
    const e = el('select', {}, ...Object.entries(options).map(([value, textContent]) => el('option', { value, textContent })));
    e.value = obj[key];
    e.onchange = () => { obj[key] = e.value; touch(); after?.(); };
    return e;
  }
  const hint = text => el('small', { className: 'muted', textContent: text });

  // ---------- editor ----------
  function renderEditor() {
    const d = cur;
    const running = run?.running;
    const head = el('div', { className: 'dhead' },
      inp(d, 'name', { className: 'dname', placeholder: 'Deployment name' }),
      el('span', { className: 'grow' }),
      el('button', { className: 'dsave' + (dirty ? ' dirty' : ''), textContent: 'Save', onclick: save }),
      d.id ? el('button', { textContent: 'Delete', onclick: remove }) : null,
      running
        ? el('button', { className: 'danger-btn', textContent: '■ Stop', onclick: () => api.deploy.cancel(run.id) })
        : el('button', { className: 'primary', textContent: '🚀 Run deployment', onclick: start }));

    const ssh = servers.filter(x => x.type !== 'rdp');
    const targets = el('section', { className: 'dcard' },
      el('header', {}, el('b', { textContent: 'Target servers' }), hint(`${d.targets.length} selected`)),
      el('div', { className: 'dchips' }, ...ssh.map(x => {
        const cb = el('input', { type: 'checkbox', checked: d.targets.includes(x.id) });
        cb.onchange = () => {
          d.targets = cb.checked ? [...d.targets, x.id] : d.targets.filter(id => id !== x.id);
          rerender();
        };
        return el('label', { className: 'dchip' + (cb.checked ? ' on' : '') }, cb,
          el('b', { textContent: x.name }), el('small', { className: 'mono', textContent: x.host }));
      })),
      el('label', { className: 'chk' }, (() => {
        const cb = el('input', { type: 'checkbox', checked: d.parallel });
        cb.onchange = () => { d.parallel = cb.checked; touch(); };
        return cb;
      })(), ' Run all servers in parallel'),
      hint('Sequential (default) deploys one server at a time and stops at the first failed server.'));

    ed.replaceChildren(head, targets, ...D_STAGES.map(([key, title, text], i) =>
      el('section', { className: 'dcard' },
        el('header', {}, el('span', { className: 'dnum', textContent: i + 1 }), el('b', { textContent: title }), hint(`${text} Optional.`)),
        key === 'files' ? filesBody(d) : stageBody(d.stages[key]))),
    runsBox);
  }

  function filesBody(d) {
    const add = paths => {
      if (!paths?.length) return;
      const dir = d.files.at(-1)?.remoteDir || '/tmp';
      d.files.push(...paths.map(local => ({ local, remoteDir: dir })));
      rerender();
    };
    const drop = el('div', { className: 'ddrop' },
      el('span', { textContent: 'Drop files or folders here, or ' }),
      el('button', { textContent: '＋ Add files / folders', onclick: async () => add(await api.deploy.pickFiles()) }));
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => {
      e.preventDefault();
      drop.classList.remove('over');
      add([...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean));
    };
    return el('div', {},
      ...d.files.map((f, i) => el('div', { className: 'drow' },
        el('span', { className: 'mono dlocal', textContent: f.local, title: f.local }),
        el('span', { className: 'muted', textContent: '→' }),
        inp(f, 'remoteDir', { className: 'mono', placeholder: 'remote folder, e.g. /opt/app or ~/app' }),
        iconBtn('×', 'Remove', () => { d.files.splice(i, 1); rerender(); }))),
      drop);
  }

  function stageBody(st) {
    const lib$ = el('select', { className: 'dlib' },
      el('option', { value: '', textContent: '＋ From script library…' }),
      ...lib.map(x => el('option', { value: x.id, textContent: x.name })));
    lib$.onchange = () => {
      const x = lib.find(y => y.id === lib$.value);
      if (x) { st.commands.push(x.command); rerender(); }
    };
    const addCheck = el('select', { className: 'dlib' },
      el('option', { value: '', textContent: '＋ Verification…' }),
      ...Object.entries(D_CHECKS).map(([value, textContent]) => el('option', { value, textContent })));
    addCheck.onchange = () => { if (addCheck.value) { st.checks.push(newCheck(addCheck.value)); rerender(); } };

    return el('div', { className: 'dstage' },
      el('h6', { textContent: 'Commands' }),
      ...st.commands.map((c, i) => {
        const t = el('textarea', { className: 'mono', spellcheck: false, rows: Math.min(10, Math.max(1, c.split('\n').length)), placeholder: 'command, or a multi-line script (#!/bin/bash supported)' });
        t.value = c;
        t.oninput = () => { st.commands[i] = t.value; t.rows = Math.min(10, Math.max(1, t.value.split('\n').length)); touch(); };
        return el('div', { className: 'drow' }, el('span', { className: 'dstep', textContent: `${i + 1}.` }), t,
          iconBtn('×', 'Remove', () => { st.commands.splice(i, 1); rerender(); }));
      }),
      el('div', { className: 'dadd' },
        el('button', { textContent: '＋ Command', onclick: () => { st.commands.push(''); rerender(); } }), lib$),
      el('h6', { textContent: 'Verifications' }),
      ...st.checks.map((c, i) => checkRow(st, c, i)),
      el('div', { className: 'dadd' }, addCheck));
  }

  function checkRow(st, c, i) {
    const type = sel(c, 'type', D_CHECKS, () => { st.checks[i] = newCheck(c.type, c.onFail); rerender(); });
    let fields;
    if (c.type === 'log') {
      fields = [inp(c, 'file', { className: 'mono w2', placeholder: '/var/log/app.log' }),
        sel(c, 'expect', { present: 'contains', absent: 'does not contain' }),
        inp(c, 'pattern', { className: 'mono w2', placeholder: 'regex, e.g. Started|listening on' }),
        el('span', { className: 'muted', textContent: 'in last' }),
        inp(c, 'lines', { type: 'number', min: 1, className: 'num' }),
        el('span', { className: 'muted', textContent: 'lines' })];
    } else if (c.type === 'port') {
      fields = [inp(c, 'host', { className: 'mono w2', placeholder: 'host (default: the target server)' }),
        inp(c, 'port', { type: 'number', min: 1, max: 65535, className: 'num', placeholder: 'port' }),
        el('span', { className: 'muted', textContent: 'responds (checked from this Mac)' })];
    } else {
      fields = [inp(c, 'command', { className: 'mono w3', placeholder: 'e.g. systemctl is-active nginx' }),
        el('span', { className: 'muted', textContent: 'exits' }),
        inp(c, 'expectCode', { type: 'number', className: 'num' })];
    }
    return el('div', { className: 'drow dcheck' }, type, ...fields,
      el('span', { className: 'muted', textContent: 'wait up to' }),
      inp(c, 'timeout', { type: 'number', min: 0, className: 'num', title: 'Retry every 2 s for up to this many seconds (0 = check once)' }),
      el('span', { className: 'muted', textContent: 's' }),
      sel(c, 'onFail', { stop: 'If it fails: stop', alert: 'If it fails: alert only' }),
      iconBtn('×', 'Remove', () => { st.checks.splice(i, 1); rerender(); }));
  }

  // ---------- save / delete ----------
  async function save() {
    try {
      const saved = await api.deploy.save(cur);
      cur.id = saved.id;
      dirty = false;
      await load(saved.id);
      return true;
    } catch (e) { toast(cleanErr(e), true); return false; }
  }
  async function remove() {
    if (!confirm(`Delete deployment "${cur.name}"?`)) return;
    await api.deploy.delete(cur.id);
    cur = null; dirty = false;
    load();
  }

  // ---------- run ----------
  async function start() {
    if (!cur.targets.length) return toast('Pick at least one target server.', true);
    if (!(await save())) return;
    let r;
    try { r = await api.deploy.run(cur); } catch (e) { return toast(cleanErr(e), true); }
    run = { id: r.runId, name: cur.name, running: true, started: new Date(), targets: new Map() };
    deployRunHandlers.set(r.runId, onEvent);
    buildRunView(r.targets);
    renderEditor();
  }

  function buildRunView(targets) {
    runsBox.hidden = false;
    const rows = targets.map(t => {
      const badge = el('span', { className: 'dbadge pending', textContent: D_STATUS.pending });
      const pills = Object.fromEntries(D_STAGES.map(([k, title]) => [k, el('span', { className: 'dpill', textContent: title })]));
      const logEl = el('pre', { className: 'dlog mono' });
      const det = el('details', {},
        el('summary', {}, badge, el('b', { textContent: t.name }), el('small', { className: 'mono muted', textContent: t.host }),
          el('span', { className: 'grow' }), ...Object.values(pills)),
        logEl);
      run.targets.set(t.id, { badge, pills, logEl, det });
      return det;
    });
    runsBox.replaceChildren(
      el('header', {}, el('b', { textContent: `Run: ${run.name}` }),
        el('small', { className: 'muted', textContent: ` started ${run.started.toLocaleTimeString()}` }),
        el('span', { className: 'grow' }), el('span', { className: 'drunstate', textContent: 'Running…' })),
      ...rows);
  }

  function onEvent(ev) {
    if (ev.kind === 'done') {
      run.running = false;
      deployRunHandlers.delete(run.id);
      const states = [...run.targets.values()].map(t => t.status);
      const failed = states.filter(x => x === 'failed').length;
      const summary = failed ? `${failed} of ${states.length} failed`
        : states.includes('warning') ? 'Finished with alerts' : states.includes('cancelled') ? 'Cancelled' : 'All servers succeeded';
      runsBox.querySelector('.drunstate').textContent = summary;
      toast(`${run.name}: ${summary}`, !!failed);
      if (cur) renderEditor();
      return;
    }
    const t = run.targets.get(ev.target);
    if (!t) { if (ev.kind === 'log') toast(ev.text, true); return; }
    if (ev.kind === 'status') {
      t.status = ev.status;
      t.badge.className = `dbadge ${ev.status}`;
      t.badge.textContent = D_STATUS[ev.status] || ev.status;
      if (ev.status === 'running' || ev.status === 'failed') t.det.open = true;
    } else if (ev.kind === 'stage') {
      t.pills[ev.stage].className = `dpill ${ev.state}`;
    } else if (ev.kind === 'log') {
      const atBottom = t.logEl.scrollHeight - t.logEl.scrollTop - t.logEl.clientHeight < 30;
      const line = ev.level === 'out' ? ev.text : ev.text + '\n';
      t.logEl.append(el('span', { className: `l-${ev.level}`, textContent: line }));
      if (atBottom) t.logEl.scrollTop = t.logEl.scrollHeight;
    }
  }

  load();
  return { reload: load };
}
