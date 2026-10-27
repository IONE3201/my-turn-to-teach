/* My Turn to Teach — Stage I laptop prototype.
 *
 * Pipeline (mirrors the planned on-device design):
 *   camera -> hand landmarks (21 points per hand) -> geometry compares the live
 *   pose with the instructor's recorded pose -> a short spoken hint, or "step done"
 *   -> the learner teaches a tip back -> the tip is confirmed, saved, and offered
 *   again in the next session.
 *
 * Geometry decides right or wrong. Language only phrases the hint.
 */
'use strict';

// ---------------------------------------------------------------- storage
const KEYS = { craft: 'mttt.craft.v1', tips: 'mttt.tips.v1', settings: 'mttt.settings.v1', results: 'mttt.results.v1' };
function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('Could not save', key, e); }
}

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- timing constants (ms)
const HOLD_MS = 800;        // a matching pose must be held this long to complete a step
const DWELL_MS = 1500;      // a wrong pose must persist this long before a hint is given
const HINT_GAP_MS = 5000;   // minimum gap between two hints
const RECORD_MS = 700;      // frames averaged when recording a reference pose
const SAMPLE_MS = 1000;     // frames sampled per accuracy-check trial

// ---------------------------------------------------------------- state
const settings = Object.assign({ mirror: true, view: 'front', strict: 0.5, voice: true }, loadJSON(KEYS.settings, {}));
let craft = loadJSON(KEYS.craft, { name: '', steps: [] });
let tips = loadJSON(KEYS.tips, []);
let results = loadJSON(KEYS.results, null) || freshResults();

function freshResults() {
  return { frames: 0, tracked: 0, trials: [], hintDelays: [], fps: null, updated: null };
}

const state = {
  running: false, live: { n: 0 }, lastCmp: null, fps: 0, lastFrameAt: 0,
  recording: null, session: null, evalRun: null, lastClipUrl: null,
};

// ---------------------------------------------------------------- geometry
const TIPS = [8, 12, 16, 20];
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

/** MediaPipe landmarks ({x,y} in 0..1) -> isotropic points: y in 0..1, x in 0..aspect. */
function toIso(landmarks, aspect, mirror) {
  return landmarks.map((p) => [(mirror ? 1 - p.x : p.x) * aspect, p.y]);
}
function handSize(pts) { return dist(pts[0], pts[9]) || 1e-6; }
function normalizeHand(pts) {
  const s = handSize(pts), o = pts[0];
  return pts.map((p) => [(p[0] - o[0]) / s, (p[1] - o[1]) / s]);
}
function makeHand(pts) {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  return { pts, size: handSize(pts), wrist: pts[0], norm: normalizeHand(pts), cx };
}
/** Turn a list of hands (each 21 iso points) into a pose descriptor. Left/right = position on screen. */
function describe(list) {
  const hs = (list || []).filter((p) => p && p.length === 21).map(makeHand).sort((a, b) => a.cx - b.cx);
  if (hs.length >= 2) {
    const L = hs[0], R = hs[hs.length - 1], s = (L.size + R.size) / 2;
    return { n: 2, L, R, rel: [(L.wrist[0] - R.wrist[0]) / s, (L.wrist[1] - R.wrist[1]) / s] };
  }
  if (hs.length === 1) return { n: 1, S: hs[0] };
  return { n: 0 };
}
function shapeErr(a, b) {
  let sum = 0;
  for (let i = 0; i < 21; i++) sum += dist(a[i], b[i]);
  return sum / 21;
}
function thresholds(strict) {
  return { shape: 0.55 - 0.30 * strict, rel: 1.2 - 0.7 * strict };
}
/** Compare a live pose with a reference pose. score <= 1 means "match". */
function compare(live, ref, strict) {
  const t = thresholds(strict);
  if (!ref || !ref.n) return { match: false, reason: 'noref', score: Infinity, t };
  if (!live || live.n < ref.n) return { match: false, reason: 'count', need: ref.n, have: live ? live.n : 0, score: Infinity, t };
  if (ref.n === 1) {
    const cands = live.n === 1 ? [live.S] : [live.L, live.R];
    let best = null;
    for (const c of cands) {
      const e = shapeErr(c.norm, ref.S.norm);
      if (!best || e < best.e) best = { e, hand: c };
    }
    const score = best.e / t.shape;
    return { match: score <= 1, reason: score <= 1 ? 'ok' : 'shape', errS: best.e, hand: best.hand, score, t };
  }
  const eL = shapeErr(live.L.norm, ref.L.norm);
  const eR = shapeErr(live.R.norm, ref.R.norm);
  const d = [live.rel[0] - ref.rel[0], live.rel[1] - ref.rel[1]];
  const eRel = Math.hypot(d[0], d[1]);
  const rL = eL / t.shape, rR = eR / t.shape, rRel = eRel / t.rel;
  const score = Math.max(rL, rR, rRel);
  let reason = 'ok';
  if (score > 1) reason = (rRel >= rL && rRel >= rR) ? 'rel' : (rL >= rR ? 'shapeL' : 'shapeR');
  return { match: score <= 1, reason, eL, eR, eRel, d, score, t };
}

function openness(norm) { return TIPS.reduce((a, i) => a + Math.hypot(norm[i][0], norm[i][1]), 0) / TIPS.length; }
function pinch(norm) { return dist(norm[4], norm[8]); }
function angleDeg(norm) { return Math.atan2(norm[9][1], norm[9][0]) * 180 / Math.PI; }
function wrapDeg(a) { while (a > 180) a -= 360; while (a < -180) a += 360; return a; }

function shapeHint(norm, refNorm, side) {
  const hand = side ? `your ${side} hand` : 'your hand';
  const fingers = side ? `your ${side} fingers` : 'your fingers';
  const thumb = side ? `your ${side} thumb and first finger` : 'your thumb and first finger';
  const p = pinch(norm), pr = pinch(refNorm);
  if (pr < 0.45 && p - pr > 0.3) return `Bring ${thumb} together.`;
  const o = openness(norm), or = openness(refNorm);
  if (o - or < -0.25) return `Open ${fingers} a little more.`;
  if (o - or > 0.25) return `Close ${fingers} a little.`;
  if (pr > 0.8 && pr - p > 0.4) return `Open ${thumb} a little.`;
  const da = wrapDeg(angleDeg(norm) - angleDeg(refNorm));
  if (da > 20) return `Tilt ${fingers} a little to the left.`;
  if (da < -20) return `Tilt ${fingers} a little to the right.`;
  return `Match ${hand} to the picture.`;
}
/** One short sentence for the largest deviation. Templates here; an on-device LLM would only rephrase. */
function hintFor(cmp, live, ref, view) {
  if (!cmp || cmp.match) return null;
  if (cmp.reason === 'count') {
    if (cmp.need === 2) return cmp.have === 1 ? 'I can only see one hand. Please keep both hands in view.' : "I can't see your hands. Please keep both hands in view.";
    return "I can't see your hand. Please keep it in view.";
  }
  if (cmp.reason === 'rel') {
    const [ex, ey] = cmp.d;
    if (Math.abs(ey) >= Math.abs(ex)) {
      if (ey > 0) return view === 'overhead' ? 'Move your left hand a little further from you.' : 'Lift your left hand a little.';
      return view === 'overhead' ? 'Bring your left hand a little closer to you.' : 'Lower your left hand a little.';
    }
    return ex > 0 ? 'Move your hands a little further apart.' : 'Bring your hands a little closer together.';
  }
  if (cmp.reason === 'shapeL') return shapeHint(live.L.norm, ref.L.norm, 'left');
  if (cmp.reason === 'shapeR') return shapeHint(live.R.norm, ref.R.norm, 'right');
  if (cmp.reason === 'shape') return shapeHint(cmp.hand.norm, ref.S.norm, '');
  return null;
}

function refOf(step) {
  if (!step._ref) step._ref = describe(step.hands);
  return step._ref;
}
/** A tip without its closing punctuation, so it can sit inside a spoken sentence. */
function plain(text) { return String(text).trim().replace(/[.!?。！？\s]+$/u, ''); }
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------------------------------------------------------------- speech
let bubbleTimer = null;
function showBubble(text, ms) {
  const el = $('#bubble');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => el.classList.add('hidden'), ms || Math.max(3500, text.length * 80));
}
function speak(text, opts) {
  opts = opts || {};
  showBubble(text);
  const t0 = performance.now();
  let ended = false;
  const finish = () => { if (ended) return; ended = true; if (opts.onend) opts.onend(); };
  if (!settings.voice || !('speechSynthesis' in window)) {
    requestAnimationFrame(() => { if (opts.onstart) opts.onstart(performance.now() - t0, 'display'); });
    setTimeout(finish, Math.min(4000, 700 + text.length * 40));
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    u.onstart = () => { if (opts.onstart) opts.onstart(performance.now() - t0, 'speech'); };
    u.onend = finish;
    u.onerror = finish;
    window.speechSynthesis.speak(u);
  } catch (e) { /* fall through to the safety timer */ }
  setTimeout(finish, 2500 + text.length * 110);   // safety net when no voice is installed
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let activeRec = null;
function listen(onText, onDone) {
  if (!SR) { onDone(null, 'unsupported'); return; }
  stopListening();
  let finalText = '', err = null;
  const rec = new SR();
  activeRec = rec;
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onresult = (ev) => {
    let text = '';
    for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
    finalText = text.trim();
    onText(finalText);
  };
  rec.onerror = (ev) => { err = ev.error || 'error'; };
  rec.onend = () => { if (activeRec === rec) activeRec = null; onDone(finalText, err); };
  try { rec.start(); } catch (e) { onDone(null, 'error'); }
}
function stopListening() {
  if (activeRec) { try { activeRec.abort(); } catch (e) {} activeRec = null; }
}

// Keep the learner's own voice for the story card (in memory only, never uploaded).
let micStream = null, clipRec = null;
async function startClip() {
  try {
    if (!navigator.mediaDevices || !window.MediaRecorder) return;
    if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    clipRec = new MediaRecorder(micStream);
    clipRec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    clipRec.onstop = () => {
      if (!chunks.length) return;
      if (state.lastClipUrl) URL.revokeObjectURL(state.lastClipUrl);
      state.lastClipUrl = URL.createObjectURL(new Blob(chunks, { type: chunks[0].type }));
    };
    clipRec.start();
  } catch (e) { clipRec = null; }
}
function stopClip() {
  if (clipRec && clipRec.state !== 'inactive') { try { clipRec.stop(); } catch (e) {} }
  clipRec = null;
}

// ---------------------------------------------------------------- camera + hand tracking
const video = $('#video');
const overlay = $('#overlay');
const ctx = overlay.getContext('2d');
let hands = null;

async function startCamera() {
  if (state.running) return;
  const btn = $('#btn-camera');
  btn.disabled = true;
  setBadge('Starting…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    overlay.width = video.videoWidth || 960;
    overlay.height = video.videoHeight || 720;
    overlay.parentElement.style.aspectRatio = `${overlay.width} / ${overlay.height}`;
    if (!hands) {
      hands = new window.Hands({ locateFile: (f) => `vendor/mediapipe-hands/${f}` });
      // modelComplexity 0 = hand_landmark_lite, the model Hailo ships for the Hailo-10H.
      hands.setOptions({ maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
      hands.onResults(onResults);
    }
    state.running = true;
    btn.textContent = 'Camera running';
    setBadge('Loading hand model…');
    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    setBadge('Camera unavailable', 'warn');
    showBubble('The camera could not start: ' + (e && e.message ? e.message : e), 8000);
  }
}
async function loop() {
  if (!state.running) return;
  if (video.readyState >= 2) {
    try { await hands.send({ image: video }); } catch (e) { console.error(e); }
  }
  requestAnimationFrame(loop);
}
function onResults(res) {
  const w = overlay.width, h = overlay.height, aspect = w / h;
  ctx.save();
  if (settings.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(res.image, 0, 0, w, h);
  ctx.restore();
  const list = (res.multiHandLandmarks || []).map((lm) => toIso(lm, aspect, settings.mirror));
  onFrame(list, performance.now());
}

/** Everything downstream of the landmark model. Tests call this directly with synthetic hands. */
function onFrame(list, now) {
  const live = describe(list);
  state.live = live;
  if (state.lastFrameAt) {
    const inst = 1000 / Math.max(1, now - state.lastFrameAt);
    state.fps = state.fps ? state.fps * 0.9 + inst * 0.1 : inst;
  }
  state.lastFrameAt = now;

  recordTick(live, now);
  const cmp = sessionTick(live, now) || evalTick(live, now) || null;
  state.lastCmp = cmp;

  drawHands(live, cmp);
  $('#stat-hands').textContent = `Hands: ${live.n}`;
  $('#stat-fps').textContent = `FPS: ${state.fps ? state.fps.toFixed(0) : '–'}`;
  $('#stat-match').textContent = cmp && isFinite(cmp.score) ? `Distance: ${cmp.score.toFixed(2)} (1.00 or less passes)` : 'Distance: –';
  if (!state.recording && !state.session && !state.evalRun) setBadge(live.n ? `${live.n} hand${live.n > 1 ? 's' : ''} tracked` : 'Show your hands', live.n ? 'ok' : '');
}

function setBadge(text, cls) {
  const b = $('#badge');
  b.textContent = text;
  b.className = 'badge' + (cls ? ' ' + cls : '');
}
function drawHands(live, cmp) {
  const h = overlay.height;
  const colour = cmp && cmp.match ? '#3DDC97' : '#F2B880';
  const each = live.n === 2 ? [live.L, live.R] : live.n === 1 ? [live.S] : [];
  ctx.lineWidth = Math.max(2, h / 240);
  for (const hand of each) {
    ctx.strokeStyle = colour;
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      ctx.moveTo(hand.pts[a][0] * h, hand.pts[a][1] * h);
      ctx.lineTo(hand.pts[b][0] * h, hand.pts[b][1] * h);
    }
    ctx.stroke();
    ctx.fillStyle = '#B8482E';
    for (const p of hand.pts) { ctx.beginPath(); ctx.arc(p[0] * h, p[1] * h, Math.max(3, h / 160), 0, Math.PI * 2); ctx.fill(); }
  }
}
function drawRef(step) {
  const c = $('#ref-canvas'), g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!step) return;
  const all = step.hands.flat();
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = Math.min((c.width - 30) / Math.max(1e-6, maxX - minX), (c.height - 30) / Math.max(1e-6, maxY - minY));
  const ox = (c.width - (maxX - minX) * s) / 2, oy = (c.height - (maxY - minY) * s) / 2;
  g.lineWidth = 3; g.strokeStyle = '#1F3A5F'; g.fillStyle = '#B8482E';
  for (const pts of step.hands) {
    g.beginPath();
    for (const [a, b] of CONNECTIONS) {
      g.moveTo((pts[a][0] - minX) * s + ox, (pts[a][1] - minY) * s + oy);
      g.lineTo((pts[b][0] - minX) * s + ox, (pts[b][1] - minY) * s + oy);
    }
    g.stroke();
    for (const p of pts) { g.beginPath(); g.arc((p[0] - minX) * s + ox, (p[1] - minY) * s + oy, 4, 0, Math.PI * 2); g.fill(); }
  }
}
function snapshot(maxW) {
  const w = overlay.width, h = overlay.height;
  if (!w || !h || video.readyState < 2) return '';
  const c = document.createElement('canvas');
  c.width = maxW; c.height = Math.round(maxW * h / w);
  const g = c.getContext('2d');
  if (settings.mirror) { g.translate(c.width, 0); g.scale(-1, 1); }
  g.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}
function countdown(n, done) {
  const el = $('#countdown');
  el.classList.remove('hidden');
  el.textContent = n;
  const id = setInterval(() => {
    n -= 1;
    if (n <= 0) { clearInterval(id); el.classList.add('hidden'); done(); }
    else el.textContent = n;
  }, 1000);
  return () => { clearInterval(id); el.classList.add('hidden'); };
}

// ---------------------------------------------------------------- 1 · record the instructor's demo
function startRecording() {
  if (!state.running) { showBubble('Start the camera first.'); return; }
  if (state.recording || state.session || state.evalRun) return;
  const name = $('#step-name').value.trim() || `Step ${craft.steps.length + 1}`;
  state.recording = { name, phase: 'countdown', frames: [] };
  setBadge('Hold the pose…', 'warn');
  countdown(3, () => { if (state.recording) { state.recording.phase = 'capture'; state.recording.until = performance.now() + RECORD_MS; } });
}
function recordTick(live, now) {
  const r = state.recording;
  if (!r || r.phase !== 'capture') return;
  if (live.n > 0) r.frames.push(live);
  if (now < r.until) return;
  state.recording = null;
  const two = r.frames.filter((f) => f.n === 2), one = r.frames.filter((f) => f.n === 1);
  const use = two.length >= one.length ? two : one;
  if (use.length < 3) { setBadge('No hands seen', 'warn'); showBubble('I could not see your hands. Try again with both hands in view.'); return; }
  const avg = (sel) => {
    const out = [];
    for (let i = 0; i < 21; i++) {
      let x = 0, y = 0;
      for (const f of use) { const p = sel(f).pts[i]; x += p[0]; y += p[1]; }
      out.push([+(x / use.length).toFixed(5), +(y / use.length).toFixed(5)]);
    }
    return out;
  };
  const handsRef = use[0].n === 2 ? [avg((f) => f.L), avg((f) => f.R)] : [avg((f) => f.S)];
  craft.steps.push({ id: 's' + Date.now().toString(36), name: r.name, hands: handsRef, photo: snapshot(320) });
  craft.name = $('#craft-name').value.trim() || craft.name || 'My craft';
  persistCraft();
  $('#step-name').value = '';
  renderSteps();
  setBadge('Step saved', 'ok');
  showBubble(`Saved "${r.name}" with ${handsRef.length} hand${handsRef.length > 1 ? 's' : ''}.`);
}
function persistCraft() {
  saveJSON(KEYS.craft, { name: craft.name, steps: craft.steps.map((s) => ({ id: s.id, name: s.name, hands: s.hands, photo: s.photo })) });
}
function renderSteps() {
  $('#craft-name').value = craft.name || '';
  const ol = $('#step-list');
  ol.innerHTML = '';
  craft.steps.forEach((s, i) => {
    const li = document.createElement('li');
    if (s.photo) { const img = document.createElement('img'); img.src = s.photo; img.alt = `Photo of step ${i + 1}`; li.appendChild(img); }
    const span = document.createElement('span');
    span.textContent = `${s.name} · ${s.hands.length} hand${s.hands.length > 1 ? 's' : ''}`;
    li.appendChild(span);
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.addEventListener('click', () => { craft.steps.splice(i, 1); persistCraft(); renderSteps(); });
    li.appendChild(del);
    ol.appendChild(li);
  });
}

// ---------------------------------------------------------------- 2 · session
function findTip(stepId, learner) {
  for (let i = tips.length - 1; i >= 0; i--) {
    const t = tips[i];
    if (t.stepId === stepId && t.learner === learner) return t;
  }
  return null;
}
function startSession() {
  if (!state.running) { showBubble('Start the camera first.'); return; }
  if (!craft.steps.length) { showBubble('Record at least one step first.'); return; }
  stopEval();
  const learner = $('#elder-name').value.trim() || 'Guest';
  state.session = { i: -1, phase: 'idle', learner, tipsToday: [], matchSince: null, wrongSince: null, lastHintAt: -Infinity };
  $('#story').classList.add('hidden');
  nextStep();
}
function stopSession() {
  if (!state.session) return;
  state.session = null;
  stopListening(); stopClip();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  $('#teach').classList.add('hidden');
  $('#tipcard').classList.add('hidden');
  $('#session-progress').textContent = 'Session stopped';
  setBadge('Stopped');
}
function nextStep() {
  const s = state.session;
  if (!s) return;
  s.i += 1;
  $('#teach').classList.add('hidden');
  if (s.i >= craft.steps.length) { finishSession(); return; }
  const step = craft.steps[s.i];
  s.phase = 'intro'; s.matchSince = null; s.wrongSince = null;
  $('#session-progress').textContent = `Step ${s.i + 1} of ${craft.steps.length}`;
  $('#session-title').textContent = step.name;
  const photo = $('#ref-photo');
  if (step.photo) { photo.src = step.photo; photo.classList.remove('hidden'); } else photo.classList.add('hidden');
  drawRef(step);
  const tip = findTip(step.id, s.learner);
  let line = `Step ${s.i + 1}. ${step.name}.`;
  if (tip) {
    $('#tip-text').textContent = `"${tip.text}"`;
    $('#tipcard').classList.remove('hidden');
    line += ` Last time you taught me: ${plain(tip.text)}. Shall we do it your way today?`;
  } else $('#tipcard').classList.add('hidden');
  setBadge(`Step ${s.i + 1}`, '');
  speak(line, { onend: () => { if (state.session === s && s.phase === 'intro') { s.phase = 'doing'; s.wrongSince = null; s.matchSince = null; } } });
}
function sessionTick(live, now) {
  const s = state.session;
  if (!s || (s.phase !== 'doing' && s.phase !== 'intro')) return null;
  const step = craft.steps[s.i], ref = refOf(step);
  const cmp = compare(live, ref, settings.strict);
  if (s.phase !== 'doing') return cmp;

  results.frames += 1;
  if (live.n >= ref.n) results.tracked += 1;

  if (cmp.match) {
    s.wrongSince = null;
    if (!s.matchSince) s.matchSince = now;
    setBadge('That looks right. Hold it…', 'ok');
    if (now - s.matchSince >= HOLD_MS) completeStep();
    return cmp;
  }
  s.matchSince = null;
  if (!s.wrongSince) s.wrongSince = now;
  setBadge(`Step ${s.i + 1}`, '');
  if (now - s.wrongSince >= DWELL_MS && now - s.lastHintAt >= HINT_GAP_MS) {
    const text = hintFor(cmp, live, ref, settings.view);
    if (text) {
      const waited = now - s.wrongSince;
      s.lastHintAt = now;
      speak(text, { onstart: (ms, kind) => { results.hintDelays.push({ dwellMs: Math.round(waited), startMs: Math.round(ms), kind }); persistResults(); } });
    }
  }
  return cmp;
}
function completeStep() {
  const s = state.session;
  s.phase = 'praise';
  persistResults();
  const step = craft.steps[s.i];
  setBadge('Step done', 'ok');
  const hasTip = !!findTip(step.id, s.learner);
  speak(hasTip ? 'Well done. Your way works.' : 'Well done.', { onend: () => {
    if (state.session !== s) return;
    if (hasTip) nextStep(); else askForTip();
  } });
}
function askForTip() {
  const s = state.session;
  s.phase = 'teach';
  const step = craft.steps[s.i];
  $('#teach').classList.remove('hidden');
  $('#teach-input').value = '';
  const prompt = `Now it is your turn to teach. What is your tip for "${step.name}"?`;
  $('#teach-prompt').textContent = prompt;
  $('#teach-status').textContent = '';
  speak('Now it is your turn to teach. What is your tip for this step?', { onend: () => { if (state.session === s && s.phase === 'teach') listenForTip(); } });
}
function listenForTip() {
  const s = state.session;
  if (!s || s.phase !== 'teach') return;
  const status = $('#teach-status');
  if (!SR) { status.textContent = 'Speech recognition is not available in this browser. Type the tip, then press "Yes, keep it".'; return; }
  status.textContent = 'Listening…';
  startClip();
  listen((text) => { $('#teach-input').value = text; }, (text, err) => {
    stopClip();
    if (state.session !== s || s.phase !== 'teach') return;
    if (!text) { status.textContent = err === 'not-allowed' ? 'The microphone is blocked. Type the tip instead.' : 'I did not catch that. Press "Listen again", or type the tip.'; return; }
    confirmTip(text);
  });
}
function confirmTip(text) {
  const s = state.session;
  s.phase = 'confirm';
  const status = $('#teach-status');
  status.textContent = 'Say "yes" to keep it, or press a button.';
  speak(`May I keep this as your tip: ${plain(text)}?`, { onend: () => {
    if (state.session !== s || s.phase !== 'confirm') return;
    if (!SR) return;
    listen(() => {}, (answer) => {
      if (state.session !== s || s.phase !== 'confirm') return;
      const a = (answer || '').toLowerCase();
      if (/\b(yes|yeah|yep|keep|okay|ok|sure)\b/.test(a)) keepTip();
      else if (/\b(no|skip|nope)\b/.test(a)) { s.phase = 'teach'; status.textContent = 'Okay. Press "Listen again" to try once more, or "Skip".'; }
      else status.textContent = 'Press "Yes, keep it" to save, or "Skip".';
    });
  } });
}
function keepTip() {
  const s = state.session;
  if (!s || (s.phase !== 'teach' && s.phase !== 'confirm')) return;
  const text = $('#teach-input').value.trim();
  if (!text) { $('#teach-status').textContent = 'There is no tip yet. Speak or type one first.'; return; }
  stopListening(); stopClip();
  const step = craft.steps[s.i];
  const tip = { craft: craft.name, stepId: step.id, stepName: step.name, learner: s.learner, text, date: new Date().toISOString(), confirmed: true };
  tips.push(tip);
  saveJSON(KEYS.tips, tips);
  s.tipsToday.push(tip);
  s.phase = 'thanks';
  renderTips();
  speak('Thank you. I will remember that.', { onend: () => { if (state.session === s) nextStep(); } });
}
function skipTip() {
  const s = state.session;
  if (!s || (s.phase !== 'teach' && s.phase !== 'confirm')) return;
  stopListening(); stopClip();
  nextStep();
}
function finishSession() {
  const s = state.session;
  s.phase = 'done';
  persistResults();
  setBadge('Finished', 'ok');
  $('#tipcard').classList.add('hidden');
  $('#session-progress').textContent = 'Finished';
  $('#session-title').textContent = 'All steps done.';
  $('#story').classList.remove('hidden');
  $('#story-title').textContent = craft.name || 'My craft';
  $('#story-meta').textContent = `${s.learner} · ${new Date().toLocaleDateString()}`;
  const ul = $('#story-tips');
  ul.innerHTML = '';
  const shown = s.tipsToday.length ? s.tipsToday : craft.steps.map((st) => findTip(st.id, s.learner)).filter(Boolean);
  for (const t of shown) { const li = document.createElement('li'); li.textContent = `"${t.text}"`; ul.appendChild(li); }
  const audio = $('#story-audio');
  if (state.lastClipUrl) { audio.src = state.lastClipUrl; audio.classList.remove('hidden'); } else audio.classList.add('hidden');
  speak(s.tipsToday.length ? 'You finished. Thank you for teaching me today.' : 'You finished. Well done.');
}

// ---------------------------------------------------------------- 3 · accuracy check
function startEval() {
  if (!state.running) { showBubble('Start the camera first.'); return; }
  if (!craft.steps.length) { showBubble('Record at least one step first.'); return; }
  stopSession();
  const n = Math.max(4, Math.min(60, parseInt($('#eval-n').value, 10) || 20));
  const targets = [];
  for (let i = 0; i < n; i++) targets.push(i % 2 === 0 ? 'correct' : 'wrong');
  for (let i = targets.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [targets[i], targets[j]] = [targets[j], targets[i]]; }
  state.evalRun = { n, k: 0, targets, phase: 'idle', cancel: null };
  $('#eval-log').innerHTML = '';
  nextTrial();
}
function stopEval() {
  const e = state.evalRun;
  if (!e) return;
  if (e.cancel) e.cancel();
  state.evalRun = null;
  $('#eval-progress').textContent = 'Stopped';
}
function nextTrial() {
  const e = state.evalRun;
  if (!e) return;
  if (e.k >= e.n) {
    state.evalRun = null;
    $('#eval-progress').textContent = 'Finished';
    $('#eval-instruction').textContent = 'Check complete. Open the Results tab.';
    setBadge('Check complete', 'ok');
    renderResults();
    return;
  }
  const stepIndex = Math.floor(Math.random() * craft.steps.length);
  const step = craft.steps[stepIndex], target = e.targets[e.k];
  e.step = step; e.stepIndex = stepIndex; e.target = target; e.phase = 'prepare';
  e.frames = 0; e.matches = 0; e.tracked = 0;
  $('#eval-progress').textContent = `Trial ${e.k + 1} of ${e.n}`;
  const text = target === 'correct' ? `Do step ${stepIndex + 1} correctly: ${step.name}` : `Do step ${stepIndex + 1} WRONG on purpose. Keep your hands in view.`;
  $('#eval-instruction').textContent = text;
  setBadge(target === 'correct' ? 'Do it right' : 'Do it wrong', target === 'correct' ? 'ok' : 'warn');
  showBubble(text, 4000);
  e.cancel = countdown(3, () => { if (state.evalRun === e) { e.phase = 'sample'; e.until = performance.now() + SAMPLE_MS; } });
}
function evalTick(live, now) {
  const e = state.evalRun;
  if (!e || !e.step) return null;
  const ref = refOf(e.step);
  const cmp = compare(live, ref, settings.strict);
  if (e.phase !== 'sample') return cmp;
  e.frames += 1;
  if (cmp.match) e.matches += 1;
  if (live.n >= ref.n) e.tracked += 1;
  if (now < e.until) return cmp;
  e.phase = 'scored';
  const judged = e.frames > 0 && e.matches / e.frames > 0.5;
  const ok = judged === (e.target === 'correct');
  results.frames += e.frames;
  results.tracked += e.tracked;
  results.trials.push({ step: e.stepIndex + 1, target: e.target, judged: judged ? 'correct' : 'wrong', ok, frames: e.frames });
  persistResults();
  const li = document.createElement('li');
  li.className = ok ? 'ok' : 'bad';
  li.textContent = `Step ${e.stepIndex + 1}, asked for ${e.target}, judged ${judged ? 'correct' : 'wrong'}: ${ok ? 'agrees' : 'disagrees'}`;
  $('#eval-log').appendChild(li);
  e.k += 1;
  setTimeout(nextTrial, 700);
  return cmp;
}

// ---------------------------------------------------------------- 4 · results
function persistResults() {
  results.fps = state.fps ? Math.round(state.fps) : results.fps;
  results.updated = new Date().toISOString();
  saveJSON(KEYS.results, results);
}
function summary() {
  const acc = results.trials.length ? results.trials.filter((t) => t.ok).length / results.trials.length : null;
  const speech = results.hintDelays.filter((d) => d.kind === 'speech');
  const pool = speech.length ? speech : results.hintDelays;
  const total = median(pool.map((d) => d.dwellMs + d.startMs));
  return {
    trackingRate: results.frames ? results.tracked / results.frames : null,
    accuracy: acc, trials: results.trials.length,
    hintDelayMs: total, hintStartMs: median(pool.map((d) => d.startMs)), hints: pool.length,
    hintKind: speech.length ? 'speech' : (pool.length ? 'display' : null),
    frames: results.frames, fps: results.fps,
  };
}
function renderResults() {
  const s = summary();
  $('#m-track').textContent = s.trackingRate == null ? '–' : (s.trackingRate * 100).toFixed(1) + '%';
  $('#m-acc').textContent = s.accuracy == null ? '–' : (s.accuracy * 100).toFixed(0) + '%';
  $('#m-lat').textContent = s.hintDelayMs == null ? '–' : (s.hintDelayMs / 1000).toFixed(1) + ' s';
  const bits = [];
  bits.push(`${s.frames} frames measured${s.fps ? ` at about ${s.fps} FPS` : ''}.`);
  bits.push(`${s.trials} accuracy trials.`);
  if (s.hints) bits.push(`${s.hints} hints; the delay includes a fixed ${DWELL_MS / 1000} s wait before hinting, plus a median ${Math.round(s.hintStartMs)} ms for ${s.hintKind === 'speech' ? 'speech to start' : 'the hint to appear (voice was off)'}.`);
  bits.push(`Strictness ${Math.round(settings.strict * 100)}.`);
  $('#m-detail').textContent = bits.join(' ');
  renderTips();
}
function renderTips() {
  const ul = $('#tips-list');
  ul.innerHTML = '';
  if (!tips.length) { const li = document.createElement('li'); li.textContent = 'No tips saved yet.'; ul.appendChild(li); return; }
  for (const t of tips) {
    const li = document.createElement('li');
    li.textContent = `${t.learner}, ${t.stepName}: "${t.text}" (${new Date(t.date).toLocaleDateString()})`;
    ul.appendChild(li);
  }
}
function download(name, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- wiring
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('hidden', p.id !== 'pane-' + name));
  if (name === 'results') renderResults();
}
function init() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('#btn-camera').addEventListener('click', startCamera);
  $('#opt-mirror').checked = settings.mirror;
  $('#opt-view').value = settings.view;
  $('#opt-strict').value = Math.round(settings.strict * 100);
  $('#opt-voice').checked = settings.voice;
  $('#opt-mirror').addEventListener('change', (e) => { settings.mirror = e.target.checked; saveJSON(KEYS.settings, settings); });
  $('#opt-view').addEventListener('change', (e) => { settings.view = e.target.value; saveJSON(KEYS.settings, settings); });
  $('#opt-strict').addEventListener('input', (e) => { settings.strict = e.target.value / 100; saveJSON(KEYS.settings, settings); });
  $('#opt-voice').addEventListener('change', (e) => { settings.voice = e.target.checked; saveJSON(KEYS.settings, settings); });

  $('#btn-record').addEventListener('click', startRecording);
  $('#craft-name').addEventListener('change', (e) => { craft.name = e.target.value.trim(); persistCraft(); });
  $('#btn-export').addEventListener('click', () => { persistCraft(); download('craft.json', loadJSON(KEYS.craft, craft)); });
  $('#btn-clear').addEventListener('click', () => { if (confirm('Remove all recorded steps?')) { craft.steps = []; persistCraft(); renderSteps(); } });
  $('#file-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.steps) || data.steps.some((s) => !Array.isArray(s.hands) || s.hands.some((h) => h.length !== 21))) throw new Error('not a craft file');
      craft = { name: data.name || 'Imported craft', steps: data.steps };
      persistCraft(); renderSteps(); showBubble(`Imported ${craft.steps.length} steps.`);
    } catch (err) { showBubble('That file could not be read as a craft file.'); }
    e.target.value = '';
  });

  $('#btn-start').addEventListener('click', startSession);
  $('#btn-stop').addEventListener('click', stopSession);
  $('#btn-tip-listen').addEventListener('click', () => { const s = state.session; if (s && (s.phase === 'teach' || s.phase === 'confirm')) { s.phase = 'teach'; listenForTip(); } });
  $('#btn-tip-keep').addEventListener('click', keepTip);
  $('#btn-tip-skip').addEventListener('click', skipTip);
  $('#btn-photo').addEventListener('click', () => { const url = snapshot(640); if (url) $('#story-photo').src = url; });

  $('#btn-eval').addEventListener('click', startEval);
  $('#btn-eval-stop').addEventListener('click', stopEval);

  $('#btn-download').addEventListener('click', () => download('results.json', { summary: summary(), settings, constants: { HOLD_MS, DWELL_MS, HINT_GAP_MS, SAMPLE_MS }, raw: results, userAgent: navigator.userAgent }));
  $('#btn-reset-results').addEventListener('click', () => { if (confirm('Reset all measurements?')) { results = freshResults(); persistResults(); renderResults(); } });
  $('#btn-forget-tips').addEventListener('click', () => { if (confirm('Forget every saved tip?')) { tips = []; saveJSON(KEYS.tips, tips); renderTips(); } });

  renderSteps();
  renderResults();
}
document.addEventListener('DOMContentLoaded', init);

// Exposed for the automated tests in tests/.
window.MTTT = {
  describe, compare, hintFor, thresholds, toIso, onFrame, summary, state, settings,
  get craft() { return craft; }, set craft(v) { craft = v; }, get tips() { return tips; }, get results() { return results; },
  constants: { HOLD_MS, DWELL_MS, HINT_GAP_MS, RECORD_MS, SAMPLE_MS },
};
