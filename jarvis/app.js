/* JARVIS on the phone: works on its own, straight to Google (Calendar + Tasks) and Gemini.
   The laptop Hub reads the same Google data, so it sees everything done here when it next syncs. */
(() => {
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pct = f => (f * 100).toFixed(2) + '%';
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------- settings, cache and offline queue (all kept only on this phone) ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('jarvis.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('jarvis.' + k, JSON.stringify(v)); } catch (e) {} },
};
const DEF = {clientId: '', geminiKey: '', models: '', name: 'Pankaj', college: '09:00-17:00', reserved: '19:30-21:30', window: '06:00-22:00',
  workstreams: ['PhD', 'College', 'Health', 'Brand & career', 'Learning', 'Freelance', 'Books'], inbox: 'Inbox', calendar: 'JARVIS',
  tz: 'Asia/Kolkata', voiceName: '', rate: 1.0, everSignedIn: false};
let cfg = {...DEF, ...LS.get('settings', {})};
if (cfg.family) { cfg.reserved = cfg.family; delete cfg.family; LS.set('settings', cfg); }   // v1.3 settings
if ('model' in cfg) { delete cfg.model; LS.set('settings', cfg); }                           // v1.4 kept one model; v1.5 keeps a list
const spanOf = s => String(s).split('-').map(x => x.trim().split(':').map(Number));
const rules = () => ({name: cfg.name, college: spanOf(cfg.college), reserved_time: spanOf(cfg.reserved), day_window: spanOf(cfg.window), workstreams: cfg.workstreams, inbox: cfg.inbox});
let cache = LS.get('cache', {}), queue = LS.get('queue', []);
const saveCache = () => LS.set('cache', cache), saveQueue = () => LS.set('queue', queue);

/* ---------- phases + voice ---------- */
function phase(p, label) {
  window.corePhase = p;
  $('statusText').textContent = label || {idle: 'STANDING BY', thinking: 'WORKING', talking: 'SPEAKING'}[p];
  $('status').classList.toggle('err', /OFFLINE|SIGN IN|SETUP/.test(label || ''));
}
let voiceOn = LS.get('voiceOn', true), voices = [];
function loadVoices() { voices = ('speechSynthesis' in window) ? speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)) : []; fillVoiceSelect(); }
function pickVoice() {
  if (cfg.voiceName) { const v = voices.find(v => v.name === cfg.voiceName); if (v) return v; }
  return voices.find(v => /en[-_]GB/i.test(v.lang) && /male|ryan|george|thomas|daniel/i.test(v.name)) || voices.find(v => /en[-_]GB/i.test(v.lang))
      || voices.find(v => /en[-_]IN/i.test(v.lang)) || voices[0] || null;
}
if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function say(text) {
  $('caption').textContent = text;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (!voiceOn || !('speechSynthesis' in window)) { phase('talking'); setTimeout(() => phase('idle'), Math.min(8000, 1500 + text.length * 45)); return; }
  const u = new SpeechSynthesisUtterance(text), v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = Number(cfg.rate) || 1; u.pitch = 0.95;
  u.onstart = () => phase('talking');
  u.onend = u.onerror = () => phase('idle');
  speechSynthesis.speak(u);
}
function setVoiceBtn() { $('voiceBtn').setAttribute('aria-pressed', voiceOn); $('voiceBtn').textContent = voiceOn ? 'VOICE ON' : 'VOICE OFF'; }
$('voiceBtn').onclick = () => { voiceOn = !voiceOn; LS.set('voiceOn', voiceOn); setVoiceBtn(); if (!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel(); };
setVoiceBtn();

/* ---------- Google sign-in ---------- */
let gisReady = false;
window.gisLoaded = () => { gisReady = true; try { if (cfg.clientId) JGoogle.init(cfg.clientId); } catch (e) {} };
function ensureAuth() {                           // call only inside a tap: opens Google's sign-in window if needed
  if ((JGoogle.valid() && cfg.scopeVersion === JGoogle.SCOPE_VERSION) || !cfg.clientId) return Promise.resolve(JGoogle.valid());
  if (!gisReady) return Promise.resolve(false);
  try { JGoogle.init(cfg.clientId); } catch (e) { return Promise.resolve(false); }
  const consent = !cfg.everSignedIn || cfg.scopeVersion !== JGoogle.SCOPE_VERSION;
  return JGoogle.signIn(consent).then(() => { cfg.everSignedIn = true; cfg.scopeVersion = JGoogle.SCOPE_VERSION; LS.set('settings', cfg); return true; }, () => false);
}

/* ---------- sync with Google ---------- */
let syncing = null, lastError = '';
async function flushQueue(lists, calId) {
  while (queue.length) {
    const op = queue[0];
    if (op.op === 'add') {
      const t = await JGoogle.addTask(lists[op.list] || lists[cfg.inbox], op.title, op.notes, op.due);
      if (op.event && calId) await JGoogle.addEvent(calId, op.title, op.event.start, op.event.end, cfg.tz, `${op.list} · added by JARVIS phone`);
      void t;
    } else if (op.op === 'done' && !String(op.task_id).startsWith('local-')) {
      await JGoogle.setDone(op.list_id, op.task_id, op.done);
    }
    queue.shift(); saveQueue();
  }
}
/* list ids and the JARVIS calendar id hardly ever change: look them up once every 6 hours, not on every sync (v1.5) */
async function ids(force) {
  const names = [cfg.inbox, ...cfg.workstreams];
  if (!force && cache.idsAt && Date.now() - cache.idsAt < 6 * 3600e3 && names.every(n => (cache.lists || {})[n])) return;
  const [lists, calId] = await Promise.all([JGoogle.lists(), JGoogle.calendarId(cfg.calendar)]);
  for (const t of names) if (!lists[t]) lists[t] = (await JGoogle.createList(t)).id;
  Object.assign(cache, {lists, calId, idsAt: Date.now()}); saveCache();
}
async function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    await ids(false);
    try { await flushQueue(cache.lists, cache.calId); }
    catch (e) { if (e.needAuth) throw e; await ids(true); await flushQueue(cache.lists, cache.calId); }   // a list was renamed or deleted
    const lists = cache.lists, calId = cache.calId;
    const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), now.getDate()), end = new Date(start.getTime() + 86400000);
    const names = [cfg.inbox, ...cfg.workstreams];
    const [evLists, taskLists] = await Promise.all([                       // both calendars and all lists at the same time
      Promise.all(['primary', calId].filter(Boolean).map(id => JGoogle.events(id, start, end))),
      Promise.all(names.map(n => Promise.all([JGoogle.openTasks(lists[n]), JGoogle.doneSince(lists[n], start)]))),
    ]);
    const evs = [], seen = new Set();
    for (const list of evLists) for (const ev of list) if (!seen.has(ev.id)) { seen.add(ev.id); evs.push(ev); }
    const open = [], done = [];
    names.forEach((n, i) => { const id = lists[n]; taskLists[i][0].forEach(t => open.push({l: n, id, t})); taskLists[i][1].forEach(t => done.push({l: n, id, t})); });
    Object.assign(cache, {at: Date.now(), day: ymd(now), events: evs, open, done}); saveCache();
    JKnowledge.refresh(false).catch(() => {});                             // in the background: the screen never waits for Drive
    lastError = '';
  })().finally(() => { syncing = null; });
  return syncing;
}
async function refresh(interactive) {
  if (interactive) await ensureAuth();
  if (JGoogle.valid() && navigator.onLine) {
    try { await sync(); }
    catch (e) { if (!e.needAuth) lastError = e.message; }
  }
  render();
}

/* ---------- build + render the day ---------- */
function view() {
  const now = new Date(), fresh = cache.day === ymd(now);
  const mk = x => JPlanner.taskFromGoogle(x.l, x.id, x.t);
  const open = (cache.open || []).map(mk), done = fresh ? (cache.done || []).map(mk) : [];
  const t = now.getHours() * 60 + now.getMinutes(), when = cache.at ? new Date(cache.at) : null;
  const authed = JGoogle.valid();
  const status = [
    {name: 'Google sync', status: !cfg.clientId ? 'Offline' : authed ? 'Running' : 'Needs you',
     detail: !cfg.clientId ? 'add your client ID in SETTINGS' : when ? `last sync ${pad(when.getHours())}:${pad(when.getMinutes())}${authed ? '' : ' · tap CONNECT'}` : 'tap CONNECT GOOGLE'},
    (() => { const g = JGemini.status(); return {name: 'Gemini', status: cfg.geminiKey ? 'Running' : 'Offline',
      detail: !cfg.geminiKey ? 'add your key in SETTINGS' : (g.model || 'ready') + (g.resting.length ? ` · ${g.resting.length} busy model resting` : '')}; })(),
    (() => { const k = JKnowledge.status(); return {name: 'Knowledge', status: k.count ? 'Running' : 'Offline',
      detail: k.count ? `${k.count} files from Drive` : k.missing ? 'no JARVIS › Knowledge folder in Drive' : 'syncs after Google sign-in'}; })(),
    ...(queue.length ? [{name: 'Waiting to sync', status: 'Scheduled', detail: `${queue.length} change${queue.length > 1 ? 's' : ''} saved on this phone`}] : []),
    {name: 'Morning brief', status: t >= 530 ? 'Done' : 'Scheduled', detail: '08:50 via JARVIS'},
    {name: 'Evening review', status: t >= 1065 ? 'Done' : 'Scheduled', detail: '17:45 via JARVIS'},
  ];
  return JPlanner.buildToday(now, fresh ? (cache.events || []) : [], open, done, rules(), status);
}
let data = null, firstRender = true;
function render() {
  const d = data = view();
  $('clock').textContent = d.clock; $('date').textContent = d.date;
  $('windowLabel').textContent = 'TODAY · ' + d.window; $('stripHead').textContent = d.strip_head;
  const n = d.next;
  $('next').innerHTML = `<div class="k">${esc(n.label)}</div><div class="t">${esc(n.title)}</div><div class="m">${esc(n.meta)}</div>
    <div class="btns">${n.kind === 'task' ? `<button type="button" data-done="${esc(n.list_id)}|${esc(n.task_id)}|0">MARK DONE</button>` : ''}
    <button type="button" class="${n.kind === 'task' ? 'alt' : ''}" data-brief>BRIEF ME</button></div>`;
  $('top3').innerHTML = d.top3.length ? d.top3.map(p => {
    const local = String(p.task_id).startsWith('local-');
    return `<div class="pri cut${p.done ? ' done' : ''}"><div class="n">${p.n}</div>
      <div style="min-width:0"><div class="t">${esc(p.title)}</div><div class="m"><span class="tag ${p.tag}">${local ? 'SYNCING' : p.tag}</span><span>${esc(p.meta)}</span></div></div>
      <button type="button" class="chk" ${local ? 'disabled' : ''} aria-pressed="${p.done}" aria-label="${p.done ? 'Mark not done' : 'Mark done'}: ${esc(p.title)}" data-done="${esc(p.list_id)}|${esc(p.task_id)}|${p.done ? 1 : 0}"><span>${p.done ? CHECK : ''}</span></button></div>`;
  }).join('') : '<div class="empty">No open tasks. Say or type one to add it.</div>';
  const col = {Done: 'var(--off)', Running: 'var(--accent)', Scheduled: 'var(--text-2)', Offline: 'var(--alert)', 'Needs you': 'var(--alert)'};
  $('workforce').innerHTML = d.workforce.map(w => `<div class="row"><span class="dot" style="background:${col[w.status]};box-shadow:0 0 6px ${col[w.status]}"></span><div><div class="a">${esc(w.name)}</div><div class="b">${esc(w.status)} · ${esc(w.detail)}</div></div></div>`).join('');
  $('streams').innerHTML = d.streams.map(s => `<div class="ws"><b>${esc(s.name)}</b><span title="${esc(s.next)}">${esc(s.next)}</span></div>`).join('');
  $('track').innerHTML = d.bands.map(b => `<div class="band ${b.kind}" style="left:${pct(b.left)};width:${pct(b.width)}">${b.kind === 'prot' ? esc(b.label) : ''}</div>`).join('') +
    d.blocks.map(b => `<div class="blk ${b.kind}" style="left:${pct(b.left)};width:${pct(b.width)}">${esc(b.label)}</div>`).join('') +
    `<div class="nowline" style="left:${pct(d.now_left)}"></div>`;
  $('ticks').innerHTML = d.ticks.map(t => `<span style="left:${pct(t.left)}">${t.label}</span>`).join('');
  $('dotGoogle').classList.toggle('on', JGoogle.valid()); $('dotAI').classList.toggle('on', !!cfg.geminiKey);
  window.CORE.dayFrac = d.day_frac; window.CORE.done = d.tasks_arc.done; window.CORE.total = d.tasks_arc.total;
  if (window.corePhase === 'idle' || firstRender) {
    if (!cfg.clientId || !cfg.geminiKey) { phase('idle', 'SETUP NEEDED'); $('caption').innerHTML = 'Welcome. Open SETTINGS to add your Google client ID and Gemini key. <button type="button" class="startbtn" data-settings>SETTINGS</button>'; }
    else if (!JGoogle.valid()) { phase('idle', 'SIGN IN'); $('caption').innerHTML = (cache.at ? 'Showing what I saved on this phone. ' : '') + 'Tap to sync with Google. <button type="button" class="startbtn" data-connect>CONNECT GOOGLE</button>'; }
    else if (lastError) { phase('idle', 'OFFLINE'); $('caption').textContent = 'Sync problem: ' + lastError + ' Your changes are kept on this phone.'; }
    else { phase('idle'); if (firstRender || /Tap to sync|Welcome|Sync problem/.test($('caption').textContent)) $('caption').textContent = d.brief; }
    firstRender = false;
  }
}

/* ---------- actions ---------- */
function addLocal(op) {                               // show it straight away, send it when Google is reachable
  queue.push(op); saveQueue();
  const lid = (cache.lists || {})[op.list] || 'pending';
  (cache.open = cache.open || []).push({l: op.list, id: lid, t: {id: 'local-' + Date.now(), title: op.title, notes: op.notes, status: 'needsAction', ...(op.due ? {due: op.due + 'T00:00:00.000Z'} : {})}});
  saveCache();
}
async function pushChanges() {
  if (JGoogle.valid() && navigator.onLine) { try { await sync(); } catch (e) { if (!e.needAuth) lastError = e.message; } }
  render();
}
const later = () => { pushChanges(); };                  // send to Google in the background; JARVIS has already answered
const fmtDay = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONS[d.getMonth()]}`;
/* code first (instant, offline too), then Gemini; if Gemini cannot be reached, an add is saved to the Inbox for later */
async function understand(text) {
  const q = JQuick.parse(text, cfg.workstreams, cfg.inbox);
  if (q) return q;
  if (!cfg.geminiKey) throw new Error('Please add your Gemini key in SETTINGS first.');
  return JGemini.parseCommand(cfg.geminiKey, text, rules());
}
async function command(text) {
  text = text.trim(); if (!text) return;
  phase('thinking'); $('caption').textContent = '“' + text + '”';
  let cmd;
  try { cmd = await understand(text); }
  catch (e) {
    if (!navigator.onLine || /No internet/.test(e.message)) { addLocal({op: 'add', list: cfg.inbox, title: text, notes: 'P2 · 30 min · added by JARVIS phone (offline)', due: null}); render(); later(); return say('No internet. I saved it to your Inbox and will sync it later.'); }
    phase('idle'); return say('Sorry, that did not work: ' + e.message);
  }
  if (cmd.intent === 'add_task') {
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let due = JDates.resolveDate(cmd.when, now) || JDates.resolveDate(text, now);
    const tm = JDates.resolveTime(cmd.time) || JDates.resolveTime(text);
    const mins = Math.max(5, parseInt(cmd.duration_min, 10) || 30), prio = cmd.priority || 'P2';
    const ws = [...cfg.workstreams, cfg.inbox].includes(cmd.workstream) ? cmd.workstream : cfg.inbox;
    const title = (cmd.title || text).trim();
    let event = null, resNote = '';
    if (tm) {
      if (!due) { due = today; if (tm.h * 60 + tm.m <= now.getHours() * 60 + now.getMinutes()) due = new Date(today.getTime() + 86400000); }
      const s = new Date(due.getFullYear(), due.getMonth(), due.getDate(), tm.h, tm.m), e = new Date(s.getTime() + mins * 60000);
      event = {start: s.toISOString(), end: e.toISOString()};
      const [f0, f1] = rules().reserved_time, sm = tm.h * 60 + tm.m;
      if (sm < f1[0] * 60 + f1[1] && sm + mins > f0[0] * 60 + f0[1]) resNote = ' Note: that is inside your reserved time.';
    }
    addLocal({op: 'add', list: ws, title, notes: `${prio} · ${mins} min · added by JARVIS phone`, due: due ? ymd(due) : null, event});
    render();                                                  // on screen straight away (marked SYNCING until Google has it)
    const whenTxt = due ? `Due ${fmtDay(due)}` : 'No date';
    say(`Added to ${ws}: ${title}. ${whenTxt}${event ? `, with a reminder at ${pad(tm.h)}:${pad(tm.m)} in your JARVIS calendar` : ''}, ${prio}.${resNote}` +
        (JGoogle.valid() && navigator.onLine ? '' : ' It will reach Google when you are online and signed in.'));
    return later();
  }
  if (cmd.intent === 'brief') {
    if (!cache.at || Date.now() - cache.at > 120000) await pushChanges();   // older than 2 minutes: fetch first
    else render();
    return say(data.brief);
  }
  if (cmd.intent === 'write') { openWriter(cmd.kind || 'other', text); return runWriter(); }
  if (!cfg.geminiKey) return say('Please add your Gemini key in SETTINGS first.');
  try { say(await JGemini.answer(cfg.geminiKey, text, rules(), JKnowledge.context('question', text).text)); }
  catch (e) { phase('idle'); say('Sorry, I could not answer: ' + e.message); }
}

$('askForm').onsubmit = e => { e.preventDefault(); const t = $('ask').value; $('ask').value = ''; ensureAuth(); command(t); };
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-done]');
  if (b) {
    const [list_id, task_id, undo] = b.dataset.done.split('|');
    ensureAuth();
    queue.push({op: 'done', list_id, task_id, done: undo !== '1'}); saveQueue();
    const from = undo === '1' ? 'done' : 'open', to = undo === '1' ? 'open' : 'done';
    const i = (cache[from] || []).findIndex(x => x.t.id === task_id);
    if (i >= 0) { const [x] = cache[from].splice(i, 1); x.t.status = undo === '1' ? 'needsAction' : 'completed'; (cache[to] = cache[to] || []).push(x); saveCache(); }
    render(); if (undo !== '1') say('Marked done. Well done.');
    pushChanges();
  }
  if (e.target.closest('[data-brief]') && data) {
    if (cache.at && Date.now() - cache.at < 120000) { say(data.brief); ensureAuth(); }
    else ensureAuth().then(() => pushChanges()).then(() => say(data.brief));
  }
  if (e.target.closest('[data-connect]')) { const ok = await ensureAuth(); if (ok) { $('caption').textContent = 'Syncing…'; await refresh(false); say(data.brief); } }
  if (e.target.closest('[data-settings]')) openSettings();
});

/* ---------- voice in ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
$('mic').onclick = () => {
  ensureAuth();
  if (!SR) { $('ask').focus(); return say('Voice input needs Chrome. You can type instead.'); }
  if (rec) { rec.stop(); return; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = true;
  $('mic').classList.add('live'); phase('idle', 'LISTENING'); $('caption').textContent = 'Listening…';
  let finalText = '';
  rec.onresult = ev => { const t = [...ev.results].map(r => r[0].transcript).join(' '); $('ask').value = t; if (ev.results[ev.results.length - 1].isFinal) finalText = t; };
  rec.onend = () => { $('mic').classList.remove('live'); rec = null; const t = finalText || $('ask').value; $('ask').value = ''; if (t.trim()) command(t); else phase('idle'); };
  rec.onerror = () => { $('caption').textContent = 'I did not catch that. Try again, or type.'; };
  rec.start();
};

/* ---------- write panel ---------- */
function openWriter(kind, text) {
  if (kind) $('wKind').value = kind;
  if (text != null) $('wText').value = text;
  $('wpanel').hidden = false; $('writeBtn').setAttribute('aria-expanded', 'true');
}
function closeWriter() { $('wpanel').hidden = true; $('writeBtn').setAttribute('aria-expanded', 'false'); $('writeBtn').focus(); }
async function runWriter() {
  const kind = $('wKind').value, req = $('wText').value.trim();
  if (!req) { $('wMsg').textContent = 'Type what to write, or paste a draft.'; return; }
  if (!cfg.geminiKey) { $('wMsg').textContent = 'Add your Gemini key in SETTINGS first.'; return; }
  phase('thinking'); $('wOut').textContent = ''; $('wMsg').textContent = 'Writing…';
  try {
    if (JGoogle.valid()) { try { await JKnowledge.refresh(false); } catch (e) {} }
    const ctx = JKnowledge.context(kind, req);
    const out = await JGemini.write(cfg.geminiKey, kind, req, rules(), ctx.text);
    $('wOut').textContent = out;
    const words = out.split('---')[0].trim().split(/\s+/).length;
    $('wMsg').textContent = `${words} words · ${JGemini.status().model} · used ${ctx.names.length ? ctx.names.join(', ') : 'no knowledge files (sign in to Google to load them)'}`;
    say(`Draft ready: about ${words} words, on screen. Check the list at the end before you use it.`);
  } catch (e) { phase('idle'); $('wMsg').textContent = 'Writing failed: ' + e.message; }
}
$('writeBtn').onclick = () => ($('wpanel').hidden ? (openWriter(), $('wText').focus()) : closeWriter());
$('wClose').onclick = closeWriter;
$('wGo').onclick = () => { ensureAuth(); runWriter(); };
$('wCopy').onclick = async () => {
  const t = $('wOut').textContent.split('\n---')[0].trim();
  try { await navigator.clipboard.writeText(t); $('wMsg').textContent = 'Copied (without the Check list).'; } catch (e) { $('wMsg').textContent = 'Copy failed: select the text and copy it.'; }
};

/* ---------- settings panel ---------- */
function fillVoiceSelect() {
  const sel = $('sVoice'); if (!sel) return;
  sel.innerHTML = '<option value="">Automatic (British if available)</option>' + voices.map(v => `<option value="${esc(v.name)}">${esc(v.name)} · ${esc(v.lang)}</option>`).join('');
  sel.value = cfg.voiceName || '';
}
function openSettings() {
  $('sClient').value = cfg.clientId; $('sKey').value = cfg.geminiKey; $('sName').value = cfg.name;
  $('sCollege').value = cfg.college; $('sReserved').value = cfg.reserved; $('sRate').value = cfg.rate; $('sRateOut').textContent = Number(cfg.rate).toFixed(2) + '×';
  fillVoiceSelect(); $('sMsg').textContent = cfg.models ? `Gemini · ${cfg.models}` : '';
  $('vpanel').hidden = false; $('settingsBtn').setAttribute('aria-expanded', 'true'); $('sClient').focus();
}
function closeSettings() { $('vpanel').hidden = true; $('settingsBtn').setAttribute('aria-expanded', 'false'); $('settingsBtn').focus(); }
$('settingsBtn').onclick = () => ($('vpanel').hidden ? openSettings() : closeSettings());
$('sClose').onclick = closeSettings;
$('sRate').oninput = () => { $('sRateOut').textContent = Number($('sRate').value).toFixed(2) + '×'; };
$('sSave').onclick = async () => {
  const span = /^\s*\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*$/;
  if (!span.test($('sCollege').value) || !span.test($('sReserved').value)) { $('sMsg').textContent = 'Use times like 19:30-21:30.'; return; }
  const id = $('sClient').value.replace(/\s+/g, '');
  if (id && !/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id)) {
    $('sMsg').textContent = 'That client ID does not look right. It should be numbers, a dash, letters and numbers, then .apps.googleusercontent.com. Copy it again from Google Cloud.';
    return;
  }
  $('sClient').value = id;
  const keyChanged = $('sKey').value.trim() !== cfg.geminiKey, idChanged = id !== cfg.clientId;
  Object.assign(cfg, {clientId: $('sClient').value.trim(), geminiKey: $('sKey').value.trim(), name: $('sName').value.trim() || 'Pankaj',
    college: $('sCollege').value.trim(), reserved: $('sReserved').value.trim(), voiceName: $('sVoice').value, rate: Number($('sRate').value)});
  if (keyChanged) cfg.models = '';
  if (idChanged) { JGoogle.signOut(); cfg.everSignedIn = false; }
  LS.set('settings', cfg);
  $('sMsg').textContent = 'Saved.';
  if (cfg.geminiKey && !cfg.models) {
    try { $('sMsg').textContent = 'Checking your Gemini key…'; cfg.models = await JGemini.check(cfg.geminiKey); LS.set('settings', cfg); $('sMsg').textContent = `Saved. Gemini · ${cfg.models}`; }
    catch (e) { $('sMsg').textContent = 'Gemini key problem: ' + e.message; }
  }
  if (cfg.clientId && gisReady) { try { JGoogle.init(cfg.clientId); } catch (e) {} }
  render(); say('Settings saved.');
};
$('sConnect').onclick = async () => { const ok = await ensureAuth(); $('sMsg').textContent = ok ? 'Google connected.' : 'Google sign-in did not finish. If Google said the OAuth client was not found, the client ID is wrong or brand new (wait 5 minutes).'; if (ok) refresh(false); };

/* ---------- start ---------- */
setInterval(() => { render(); if (JGoogle.valid()) refresh(false); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
window.addEventListener('online', () => refresh(false));
render();
const briefAsked = new URLSearchParams(location.search).get('brief');   // opened from a JARVIS brief notification
refresh(false).then(() => {
  if (!briefAsked) return;
  history.replaceState(null, '', location.pathname);
  $('caption').innerHTML = esc(data.brief) + ' <button type="button" class="startbtn" data-brief>PLAY</button>';
  say(data.brief);                                            // may need the PLAY tap if the phone blocks sound on open
});
if (!cfg.clientId || !cfg.geminiKey) setTimeout(openSettings, 600);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
