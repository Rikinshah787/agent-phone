/** The live phone page served by the viewer. Self-contained: no external scripts or fonts. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-phone</title>
<style>
  :root { --bg: #0e1013; --panel: #171a1f; --line: #262b33; --text: #e8eaed; --muted: #9aa3ad; --accent: #7aa2ff; --you: #8bd5a0; }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f3f4f6; --panel: #ffffff; --line: #e3e6ea; --text: #15181c; --muted: #5d6670; --accent: #2f5bd8; --you: #1f8a4c; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { display: flex; gap: 20px; padding: 16px; height: 100vh; }
  .device { display: flex; flex-direction: column; align-items: center; gap: 12px; min-width: 0; }
  .screen { position: relative; height: calc(100vh - 96px); aspect-ratio: 9 / 19.5; border-radius: 28px; overflow: hidden;
            background: #000; box-shadow: 0 0 0 10px #000, 0 0 0 11px var(--line), 0 20px 50px rgba(0,0,0,.35); }
  .screen img { width: 100%; height: 100%; object-fit: contain; display: block; cursor: pointer; user-select: none; }
  .status { position: absolute; left: 8px; bottom: 8px; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: rgba(0,0,0,.55); color: #fff; }
  .buttons { display: flex; gap: 8px; }
  button { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 14px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  aside { flex: 1; min-width: 220px; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  aside h1 { font-size: 15px; margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--line); }
  aside h1 small { display: block; font-weight: 400; color: var(--muted); }
  ol { list-style: none; margin: 0; padding: 8px 14px; overflow-y: auto; flex: 1; }
  li { padding: 6px 0; border-bottom: 1px solid var(--line); word-break: break-word; }
  li time { color: var(--muted); font-size: 12px; margin-right: 8px; font-variant-numeric: tabular-nums; }
  li.you { color: var(--you); }
  .hint { color: var(--muted); font-size: 12px; padding: 10px 14px; border-top: 1px solid var(--line); }
  @media (max-width: 700px) { main { flex-direction: column; height: auto; } .screen { height: 70vh; } }
</style>
</head>
<body>
<main>
  <section class="device">
    <div class="screen"><img id="screen" alt="Phone screen"><span class="status" id="status">connecting…</span></div>
    <div class="buttons">
      <button data-key="home">Home</button>
      <button data-key="back">Back</button>
      <button id="save">Save screenshot</button>
    </div>
  </section>
  <aside>
    <h1 id="title">agent-phone<small>Live phone</small></h1>
    <ol id="feed"></ol>
    <div class="hint">Click to tap, hold for a long-press, scroll to scroll, type to type. What you do here is recorded too.</div>
  </aside>
</main>
<script>
const img = document.getElementById('screen');
const status = document.getElementById('status');
const feed = document.getElementById('feed');
let since = 0;

async function act(body) {
  status.textContent = 'working…';
  const r = await fetch('act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-phone': '1' }, body: JSON.stringify(body) });
  if (!r.ok) status.textContent = await r.text();
}

let lastUrl;
async function nextFrame() {
  try {
    const r = await fetch('frame?t=' + Date.now());
    if (!r.ok) throw new Error(await r.text());
    const url = URL.createObjectURL(await r.blob());
    img.src = url;
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = url;
    status.textContent = 'live';
    setTimeout(nextFrame, 250);
  } catch {
    status.textContent = 'waiting for the phone…';
    setTimeout(nextFrame, 2000);
  }
}

async function poll() {
  try {
    const r = await fetch('activity?since=' + since);
    const data = await r.json();
    document.getElementById('title').innerHTML = 'agent-phone<small></small>';
    document.querySelector('#title small').textContent = data.title;
    for (const item of data.items) {
      since = Math.max(since, item.at);
      const li = document.createElement('li');
      if (item.text.startsWith('You:')) li.className = 'you';
      const time = document.createElement('time');
      time.textContent = new Date(item.at).toLocaleTimeString();
      li.append(time, item.text);
      feed.prepend(li);
    }
  } catch {}
  setTimeout(poll, 1000);
}

let downAt = 0;
img.addEventListener('pointerdown', () => { downAt = Date.now(); });
img.addEventListener('pointerup', (e) => {
  const r = img.getBoundingClientRect();
  const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  const ox = (r.width - img.naturalWidth * scale) / 2;
  const oy = (r.height - img.naturalHeight * scale) / 2;
  const x = Math.round((e.clientX - r.left - ox) / scale);
  const y = Math.round((e.clientY - r.top - oy) / scale);
  if (x < 0 || y < 0 || x > img.naturalWidth || y > img.naturalHeight) return;
  act({ kind: 'tap', x, y, long: Date.now() - downAt > 600 });
});
let wheelBusy = false;
img.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (wheelBusy) return;
  wheelBusy = true;
  act({ kind: 'scroll', direction: e.deltaY > 0 ? 'down' : 'up' }).finally(() => setTimeout(() => (wheelBusy = false), 400));
}, { passive: false });
let typed = '';
let typeTimer;
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Enter') { flush(); act({ kind: 'key', key: 'enter' }); }
  else if (e.key === 'Backspace') { flush(); act({ kind: 'key', key: 'backspace' }); }
  else if (e.key.length === 1) { typed += e.key; clearTimeout(typeTimer); typeTimer = setTimeout(flush, 400); }
  else return;
  e.preventDefault();
});
function flush() { if (typed) { act({ kind: 'type', text: typed }); typed = ''; } }
document.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => act({ kind: 'key', key: b.dataset.key })));
document.getElementById('save').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = img.src; a.download = 'phone-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png'; a.click();
});

nextFrame();
poll();
</script>
</body>
</html>
`;
