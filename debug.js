/* global api */
// Debug Console window: shows main's log buffer, then live lines. Lines are text only (never HTML).
const $ = s => document.querySelector(s);
const out = $('#out');
let lines = [];

const levelOf = line => line.slice(25, 30).trim(); // "2026-11-17T10:00:00.000Z INFO  ..."
const visible = line => {
  const q = $('#q').value.toLowerCase();
  const lv = $('#lvl').value;
  return (!q || line.toLowerCase().includes(q)) && (!lv || new RegExp(`^(${lv})$`).test(levelOf(line)));
};
const row = line => Object.assign(document.createElement('div'), { className: levelOf(line), textContent: line });
const follow = () => { if ($('#follow').checked) out.scrollTop = out.scrollHeight; };
const count = () => { $('#count').textContent = `${out.childElementCount} / ${lines.length} lines`; };

function render() {
  out.replaceChildren(...lines.filter(visible).map(row));
  count();
  follow();
}

api.log.onLine(line => {
  lines.push(line);
  if (lines.length > 3000) lines.shift(); // same cap as main's buffer
  if (visible(line)) out.append(row(line));
  while (out.childElementCount > 3000) out.firstChild.remove();
  count();
  follow();
});
api.log.all().then(all => { lines = all.slice(); render(); });

$('#q').oninput = render;
$('#lvl').onchange = render;
$('#follow').onchange = follow;
$('#copy').onclick = () => navigator.clipboard.writeText(lines.filter(visible).join('\n'));
$('#clear').onclick = () => { api.log.clear(); lines = []; render(); };
$('#folder').onclick = () => api.log.openFolder();
