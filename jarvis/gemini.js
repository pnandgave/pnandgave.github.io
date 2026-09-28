/* The phone's thinking engine: Gemini through your own free API key (kept only on this phone).
   The model only understands the words; dates, times and lists are decided in code.
   v1.5 (same rules as the laptop Hub's cloud.py):
   - Google's free models are sometimes "overloaded" (503) or out of free quota (429). JARVIS keeps a short list of models,
     retries once, then moves to the next one, and rests a busy model for 10 minutes. One busy model no longer stops you.
   - Quick jobs (commands, questions) use the fast Flash-Lite models first; writing uses the full Flash models first.
     Stable models come before preview models.
   - Newer models "think" before answering, which is slow: quick jobs ask for minimal thinking, writing for low thinking.
     Thinking counts against the output limit, so writing gets a bigger limit and is no longer cut short. */
(function (root) {
  const BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const FAST = 'fast', WRITE = 'write', REST = 10 * 60 * 1000, LIST_AGE = 24 * 3600 * 1000;
  const SKIP = /(tts|live|transcrib|image|embed|audio|vision|thinking|exp|learnlm|aqa|robotics|computer|native)/i;
  const NAME = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?(-preview[\w-]*)?$/;
  const KEY = 'jarvis.gemini';                     // {models, at}: the list of usable models, re-read once a day
  const rest = {}, think = {};
  let last = '';

  const ver = n => { const m = n.match(NAME); return m ? parseFloat(m[1]) : 0; };
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {models: [], at: 0}; } catch (e) { return {models: [], at: 0}; } };
  const store = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} };

  async function listModels(key) {
    const r = await fetch(`${BASE}/models?pageSize=1000&key=${encodeURIComponent(key)}`);
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || 'Gemini key not accepted');
    const ok = [...new Set((j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, '')).filter(n => NAME.test(n) && !SKIP.test(n)))];
    if (!ok.length) throw new Error('No Gemini Flash model is available for this key');
    return ok.sort((a, b) => ver(b) - ver(a));
  }
  /* order the models for a job: stable before preview; Flash-Lite first for quick jobs, full Flash first for writing */
  function ranked(names, job) {
    const k = n => { const m = n.match(NAME) || []; const lite = !!m[2], pre = !!m[3]; return [pre ? 1 : 0, (job === FAST ? !lite : lite) ? 1 : 0, -ver(n)]; };
    return [...names].sort((a, b) => { const x = k(a), y = k(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).slice(0, 4);
  }
  async function models(key, job) {
    let s = load();
    if (!s.models.length || Date.now() - s.at > LIST_AGE || s.key !== key.slice(-6)) {
      try { s = {models: await listModels(key), at: Date.now(), key: key.slice(-6)}; store(s); }
      catch (e) { if (!s.models.length || s.key !== key.slice(-6)) throw e; }
    }
    const order = ranked(s.models, job), now = Date.now();
    return order.filter(m => !(rest[m] > now)).concat(order.filter(m => rest[m] > now));
  }
  /* thinking settings to try, fastest first; null = the model's default */
  const levels = (name, job) => ver(name) >= 3
    ? (job === FAST ? [{thinkingLevel: 'minimal'}, {thinkingLevel: 'low'}, null] : [{thinkingLevel: 'low'}, null])
    : (job === FAST ? [{thinkingBudget: 0}, null] : [null]);

  class Busy extends Error {}
  async function call(key, name, body, job, timeoutMs) {
    const lv = levels(name, job);
    let i = think[name + job] || 0;
    for (;;) {
      const b = JSON.parse(JSON.stringify(body));
      if (lv[i]) b.generationConfig.thinkingConfig = lv[i];
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
      let r, j;
      try {
        r = await fetch(`${BASE}/models/${encodeURIComponent(name)}:generateContent?key=${encodeURIComponent(key)}`,
          {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(b), signal: ctl.signal});
        j = await r.json().catch(() => ({}));
      } catch (e) {
        if (e.name === 'AbortError') throw new Busy(`${name} took too long`);
        throw new Error('No internet connection to Gemini');
      } finally { clearTimeout(timer); }
      const msg = (j.error && j.error.message) || r.statusText || `HTTP ${r.status}`;
      if (r.status === 400 && /think/i.test(msg) && i + 1 < lv.length) { i++; think[name + job] = i; continue; }
      if ([429, 500, 502, 503, 504, 403, 404].includes(r.status)) throw new Busy(msg);
      if (!r.ok) throw new Error(msg);
      const cand = (j.candidates || [])[0] || {};
      const text = ((cand.content || {}).parts || []).map(p => p.text || '').join('').trim();
      if (!text) throw new Busy(`${name} returned nothing (${cand.finishReason || 'no reason given'})`);
      return text;
    }
  }

  async function generate(key, system, text, {job = FAST, maxTokens, schema} = {}) {
    const order = await models(key, job);
    const generationConfig = {temperature: schema ? 0.1 : 0.4, ...(maxTokens ? {maxOutputTokens: maxTokens} : {}),
      ...(schema ? {responseMimeType: 'application/json', responseSchema: schema} : {})};
    const body = {systemInstruction: {parts: [{text: system}]}, contents: [{role: 'user', parts: [{text}]}], generationConfig};
    const errors = [];
    for (let n = 0; n < order.length; n++) {
      const name = order[n];
      for (let attempt = 0; attempt < 2; attempt++) {
        try { const out = await call(key, name, body, job, job === FAST ? 30000 : 150000); last = name; return out; }
        catch (e) {
          if (!(e instanceof Busy)) throw e;
          errors.push(`${name}: ${e.message}`);
          const quota = /quota|exhausted/i.test(e.message);
          if (attempt === 0 && !quota && n === 0) { await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000)); continue; }
          rest[name] = Date.now() + (quota ? 6 * REST : REST);
          break;
        }
      }
    }
    const s = load(); s.at = 0; store(s);                              // re-read the model list next time
    throw new Error(`Google's Gemini models are all busy right now (${order.length} tried). Try again in a minute. Last reply: ${(errors[errors.length - 1] || 'none').slice(0, 160)}`);
  }

  function commandPrompt(rules) {
    const lists = [...rules.workstreams, rules.inbox];
    return `You are JARVIS, ${rules.name}'s assistant. He is an assistant professor (robotics, mechatronics) doing a PhD on FDM 3D printing, who also writes a book and does freelance projects.
Classify his message:
- add_task: something he needs to do or be reminded of.
- brief: he asks about his day, plan, schedule or what is next.
- write: he wants text written, drafted, rewritten, edited or made to sound like him (paper or report section, book text, LinkedIn post, email, or 'humanise this').
- question: anything else.
kind (for write): paper, book, post, email, humanise (rewrite/edit a draft in his voice) or other; other intents use other.
For add_task choose the workstream from: ${lists.join(', ')} (use ${rules.inbox} if unsure). Write a short, clear task title starting with a verb. Copy the date words exactly as he said them into 'when' (for example 'Friday', 'tomorrow', 'next Monday', '12 Oct'); use '' if he gave no date. Copy the clock-time words exactly into 'time' (for example '5 pm', '17:30', 'at 9'); use '' if none. NEVER calculate a date or time yourself. duration_min: his estimate, else a sensible guess between 15 and 90. priority: P1 only if urgent or important, P3 if optional, else P2.
For brief or question: title '', workstream ${rules.inbox}, when '', time '', duration_min 0, priority P2.`;
  }

  async function parseCommand(key, text, rules) {
    const lists = [...rules.workstreams, rules.inbox];
    const schema = {type: 'OBJECT', properties: {
      intent: {type: 'STRING', enum: ['add_task', 'brief', 'question', 'write']},
      kind: {type: 'STRING', enum: ['paper', 'book', 'post', 'email', 'humanise', 'other']},
      title: {type: 'STRING'}, workstream: {type: 'STRING', enum: lists},
      when: {type: 'STRING'}, time: {type: 'STRING'},
      duration_min: {type: 'INTEGER'}, priority: {type: 'STRING', enum: ['P1', 'P2', 'P3']},
    }, required: ['intent', 'kind', 'title', 'workstream', 'when', 'time', 'duration_min', 'priority']};
    const d = JSON.parse(await generate(key, commandPrompt(rules), text, {job: FAST, schema}));
    if (!lists.includes(d.workstream)) d.workstream = rules.inbox;
    return d;
  }

  const answer = (key, text, rules, knowledge) => generate(key,
    `You are JARVIS, ${rules.name}'s calm, concise personal assistant. Answer in at most 4 short sentences, spoken aloud. ` +
    'Use the knowledge files below when they are relevant; if the answer is not in them and needs exact facts (standards, numbers, citations, his results), say so rather than guessing. ' +
    'Never invent numbers, references or results.' + (knowledge ? '\n\n' + knowledge : ''), text, {job: FAST, maxTokens: 1024});

  const KIND = {paper: 'a research paper or report section (Register A)', book: 'book text (Register B, teaching voice)',
    post: 'a LinkedIn or professional post (Register B)', email: 'an email (Register B, short)',
    humanise: 'an edit of his draft so it reads naturally in his own voice (keep every fact and number exactly)', other: 'the requested text'};
  /* long-form writing with the knowledge + skill files */
  const write = (key, kind, request, rules, knowledge) => generate(key,
    `You are JARVIS, writing for ${rules.name}. Produce ${KIND[kind] || KIND.other}. ` +
    'Follow the skill files exactly (voice, register, structure, rules). Use only facts from the knowledge files or the request. ' +
    'Never invent numbers, references, standards or results: write [SOURCE NEEDED] or [DATA NEEDED] instead. British spelling. ' +
    'Output the text only, then a line with ---, then "Check:" followed by a short list of facts to verify and placeholders to fill.' +
    (knowledge ? '\n\n' + knowledge : ''), request, {job: WRITE, maxTokens: 8192});

  /* for SETTINGS: check the key and say which models will be used */
  async function check(key) {
    const s = {models: await listModels(key), at: Date.now(), key: key.slice(-6)}; store(s);
    return `quick jobs: ${ranked(s.models, FAST)[0]} · writing: ${ranked(s.models, WRITE)[0]}`;
  }
  const status = () => { const now = Date.now(); return {model: last, resting: Object.keys(rest).filter(m => rest[m] > now)}; };
  const reset = () => { for (const k of Object.keys(rest)) delete rest[k]; for (const k of Object.keys(think)) delete think[k]; last = ''; };

  const api = {parseCommand, answer, write, check, status, ranked, reset, FAST, WRITE};
  if (typeof module !== 'undefined') module.exports = api; else root.JGemini = api;
})(this);
