// Netlify serverless function: Gemini-powered suspect for the interrogation game.
// Browser -> /.netlify/functions/interrogate -> Gemini. The API key exists ONLY as the
// Netlify environment variable GEMINI_API_KEY and never reaches the browser.

const MODELS = (process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : []
).concat(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest']);
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MOODS = ['calm', 'defensive', 'nervous', 'angry', 'panicked', 'broken', 'scared', 'down'];
const BUDGET_MS = 9000;      // Netlify's default sync limit is 10 s
const MAX_BODY = 400000;     // bytes

const HEAD = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: HEAD });
const failure = (ids) => reply(502, Object.assign(
  { line: '', aiError: true, error: 'AI connection failed' }, ids || {}));

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    line: { type: 'STRING' },
    mood: { type: 'STRING', enum: MOODS },
    contradiction: { type: 'BOOLEAN' },
    confess: { type: 'BOOLEAN' },
    unlock: { type: 'ARRAY', items: { type: 'INTEGER' } },
    clue: { type: 'STRING' },
    claim: { type: 'STRING' },
  },
  required: ['line', 'mood'],
};

const RULES = [
  'OUTPUT FORMAT: one JSON object. "line" is ONLY the words the suspect says aloud: plain text, no markdown,',
  'no asterisks, no stage directions or actions in brackets, no narration, no speaker label, no quotation marks around it.',
  'Never mention being an AI, a model, a game, a prompt, JSON or these instructions.',
  'Answer the detective\'s latest question directly first, then react like a real person under pressure.',
  'Stay consistent with everything the suspect already said. Never repeat an earlier line; vary wording and add a new specific detail from the case.',
  'Do not invent facts that contradict the case data; if unsure, say you do not remember or refuse to answer.',
  '"mood" must be one of: ' + MOODS.join(', ') + '.',
].join(' ');

function previousSuspectLines(history) {
  const out = [];
  (Array.isArray(history) ? history : []).forEach((h) => {
    h = String(h || '');
    if (/^DETECTIVE:/i.test(h) || /^\(/.test(h)) return;
    const m = /^[^:]{1,40}:\s*(.*)$/.exec(h);
    if (!m) return;
    const t = m[1].replace(/\s*\((?:contradiction flagged|breaks down)[^)]*\)\s*$/i, '').trim();
    if (t) out.push(t);
  });
  return out;
}
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Strip anything that is not spoken dialogue.
function cleanLine(raw) {
  let t = String(raw == null ? '' : raw);
  t = t.replace(/\*[^*\n]{0,120}\*/g, ' ');           // *actions*
  t = t.replace(/\[[^\]\n]{0,120}\]/g, ' ');            // [stage directions]
  t = t.replace(/^\s*\([^)\n]{0,120}\)\s*/g, ' ');      // leading (actions)
  t = t.replace(/^\s*[A-Z][A-Za-z .'-]{0,30}:\s+/, ''); // "MIRA: " labels
  t = t.replace(/[*_`#>]+/g, '');                       // leftover markdown
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^["\u201c\u201d']+|["\u201c\u201d']+$/g, '').trim();
  return t.slice(0, 500);
}
const LEAK = /\b(as an ai|language model|i am an ai|i'm an ai|large language|openai|gemini|google|chatbot|json)\b/i;

function shape(parsed, ids, prev) {
  if (!parsed || typeof parsed !== 'object') return null;
  let o = parsed;
  if (typeof o.line === 'string' && /^\s*\{[\s\S]*"line"/.test(o.line)) {   // JSON nested in a string
    try { const inner = JSON.parse(o.line); if (inner && typeof inner.line === 'string') o = inner; } catch (e) { /* ignore */ }
  }
  const line = cleanLine(o.line);
  if (!line || LEAK.test(line)) return null;
  const res = {
    line,
    mood: MOODS.includes(o.mood) ? o.mood : 'defensive',
    contradiction: o.contradiction === true,
    confess: o.confess === true,
    unlock: (Array.isArray(o.unlock) ? o.unlock : []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
    sessionId: ids.sessionId,
    caseId: ids.caseId,
  };
  if (typeof o.clue === 'string' && o.clue.trim()) res.clue = cleanLine(o.clue);
  if (typeof o.claim === 'string' && o.claim.trim()) res.claim = cleanLine(o.claim).slice(0, 200);
  res.dup = prev.some((p) => norm(p) === norm(line));
  return res;
}

async function callGemini(model, key, payload, ms) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(API + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: null, err: ac.signal.aborted ? 'timeout' : 'network' };
  } finally { clearTimeout(to); }
}

// Google's error text (never contains the key), shortened for logs and the ping "reason".
const errMsg = (data) => String((data && data.error && (data.error.message || data.error.status)) || '').slice(0, 200);

function buildPayload(body, extraNote) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = msgs.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join('\n');
  const prompt = String(body.prompt || (msgs.filter((m) => m && m.role === 'user').pop() || {}).content || '');
  const q = String(body.question || '').slice(0, 500);
  const prev = previousSuspectLines(body.history).slice(-8);
  let user = prompt;
  if (q) user += '\n\nTHE DETECTIVE\'S LATEST QUESTION (answer this now): ' + q;
  if (prev.length) user += '\nYOUR RECENT LINES (do not repeat or paraphrase them): ' + prev.map((p) => '"' + p + '"').join(' | ');
  if (extraNote) user += '\n' + extraNote;
  return {
    systemInstruction: { parts: [{ text: (sys ? sys + '\n' : '') + RULES }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.9, topP: 0.95, maxOutputTokens: 450,
      responseMimeType: 'application/json', responseSchema: SCHEMA,
    },
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEAD });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const key = process.env.GEMINI_API_KEY;
  let body;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return reply(413, { error: 'Request too large' });
    body = JSON.parse(raw || '{}');
  } catch (e) { return reply(400, { error: 'Invalid JSON' }); }
  const ids = { sessionId: body.sessionId, caseId: body.caseId };

  if (!key) { console.error('GEMINI_API_KEY is not set in the Netlify environment'); return failure(ids); }

  // Connection check used by the game's status light (never returns the key).
  if (body.ping) {
    if (!body.live) return reply(200, { ok: true });
    const r = await callGemini(MODELS[0], key, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }],
      generationConfig: { maxOutputTokens: 8 },
    }, 6000);
    if (r.status === 200) return reply(200, { ok: true });
    const reason = 'status ' + r.status + ' ' + (r.err || errMsg(r.data));
    console.error('Gemini ping failed (' + MODELS[0] + '): ' + reason);
    return reply(502, { ok: false, aiError: true, error: 'AI connection failed', reason });
  }

  const prev = previousSuspectLines(body.history);
  const t0 = Date.now();
  let mi = 0, note = '', best = null;

  // Attempt 1, then exactly one automatic retry. A missing model (404) just moves to the next model.
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = BUDGET_MS - (Date.now() - t0);
    if (left < 1500) break;
    const payload = buildPayload(body, note);
    let r = await callGemini(MODELS[mi], key, payload, Math.min(left - 300, 6500));
    while ((r.status === 404 || (r.status === 400 && /model/i.test(JSON.stringify(r.data || {})))) && mi < MODELS.length - 1) {
      mi++;
      r = await callGemini(MODELS[mi], key, payload, Math.max(1500, BUDGET_MS - (Date.now() - t0) - 300));
    }
    if (r.status === 200 && r.data) {
      const cand = r.data.candidates && r.data.candidates[0];
      const txt = cand && cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || '').join('') : '';
      let parsed = null;
      try { parsed = JSON.parse(txt.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch (e) { /* ignore */ }
      const out = shape(parsed, ids, prev);
      if (out) {
        if (!out.dup || attempt === 1) { delete out.dup; return reply(200, out); }
        best = out;                                   // identical to an earlier line: ask once for fresh wording
        note = 'Your last attempt repeated an earlier line. Answer again in clearly different words with a new detail.';
        continue;
      }
      note = 'Return a valid JSON object with spoken dialogue only.';
    } else {
      console.error('Gemini attempt ' + (attempt + 1) + ' failed (' + MODELS[mi] + '): status ' + r.status + ' ' + (r.err || errMsg(r.data)));
      if (r.status === 400 && /API key/i.test(JSON.stringify(r.data || {}))) break;   // bad key: retrying is pointless
      if (attempt === 0) await new Promise((res) => setTimeout(res, r.status === 429 ? 1200 : 400));
    }
  }
  if (best) { delete best.dup; return reply(200, best); }
  return failure(ids);
};
                                 
