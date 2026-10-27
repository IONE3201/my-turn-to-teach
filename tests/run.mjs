// Automated checks for the prototype's logic. No real hands are involved: the tests feed
// synthetic 21-point hands into the same code path the camera uses.
//   node tests/run.mjs            (needs the `playwright` package and a Chromium build)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
let failed = 0;
const check = (name, ok, extra) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed += 1; };

// Injected into the page: a synthetic hand generator.
const helpers = `
window.synth = (cx, cy, size, open, rotDeg) => {
  const dirs = [-150, -115, -90, -65, -40], baseR = [0.5, 1.0, 1.0, 0.95, 0.85], seg = [0.42, 0.34, 0.26];
  const pts = [[0, 0]];
  for (let f = 0; f < 5; f++) {
    const a = dirs[f] * Math.PI / 180;
    let r = baseR[f];
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
    for (const s of seg) { r += s * (0.15 + 0.85 * open); pts.push([r * Math.cos(a), r * Math.sin(a)]); }
  }
  const t = (rotDeg || 0) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return pts.map(([x, y]) => [cx + size * (x * c - y * s), cy + size * (x * s + y * c)]);
};
window.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

// ---------- A. geometry and hints
{
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base);
  await page.addScriptTag({ content: helpers });
  const r = await page.evaluate(() => {
    const M = window.MTTT, S = window.synth, strict = 0.5;
    const ref = M.describe([S(0.45, 0.6, 0.12, 1, 0), S(0.90, 0.6, 0.12, 1, 0)]);
    const run = (list, view) => { const live = M.describe(list); const c = M.compare(live, ref, strict); return { match: c.match, reason: c.reason, hint: M.hintFor(c, live, ref, view || 'front') }; };
    const jitter = (pts) => pts.map(([x, y], i) => [x + 0.004 * Math.sin(i * 7.1), y + 0.004 * Math.cos(i * 3.3)]);
    return {
      same: run([S(0.45, 0.6, 0.12, 1, 0), S(0.90, 0.6, 0.12, 1, 0)]),
      moved: run([S(0.20, 0.3, 0.12, 1, 0), S(0.65, 0.3, 0.12, 1, 0)]),          // same pose elsewhere in frame
      scaled: run([S(0.45, 0.6, 0.09, 1, 0), S(0.7875, 0.6, 0.09, 1, 0)]),        // same pose further from camera
      jitter: run([jitter(S(0.45, 0.6, 0.12, 1, 0)), jitter(S(0.90, 0.6, 0.12, 1, 0))]),
      low: run([S(0.45, 0.80, 0.12, 1, 0), S(0.90, 0.6, 0.12, 1, 0)]),
      lowOverhead: run([S(0.45, 0.80, 0.12, 1, 0), S(0.90, 0.6, 0.12, 1, 0)], 'overhead'),
      high: run([S(0.45, 0.40, 0.12, 1, 0), S(0.90, 0.6, 0.12, 1, 0)]),
      close: run([S(0.70, 0.6, 0.12, 1, 0), S(0.90, 0.6, 0.12, 1, 0)]),
      closedL: run([S(0.45, 0.6, 0.12, 0, 0), S(0.90, 0.6, 0.12, 1, 0)]),
      rotR: run([S(0.45, 0.6, 0.12, 1, 0), S(0.90, 0.6, 0.12, 1, 40)]),
      one: run([S(0.45, 0.6, 0.12, 1, 0)]),
      none: run([]),
      swappedOrder: run([S(0.90, 0.6, 0.12, 1, 0), S(0.45, 0.6, 0.12, 1, 0)]),     // detector order must not matter
    };
  });
  check('identical pose matches', r.same.match);
  check('same pose elsewhere in the frame matches', r.moved.match);
  check('same pose at a different distance matches', r.scaled.match);
  check('small landmark jitter still matches', r.jitter.match);
  check('detector hand order does not matter', r.swappedOrder.match);
  check('left hand too low -> lift hint', !r.low.match && r.low.hint === 'Lift your left hand a little.', r.low.hint);
  check('overhead camera changes the wording', r.lowOverhead.hint === 'Move your left hand a little further from you.', r.lowOverhead.hint);
  check('left hand too high -> lower hint', r.high.hint === 'Lower your left hand a little.', r.high.hint);
  check('hands too close -> apart hint', r.close.hint === 'Move your hands a little further apart.', r.close.hint);
  check('closed left hand -> open fingers hint', !r.closedL.match && /Open your left fingers/.test(r.closedL.hint || ''), r.closedL.hint);
  check('rotated right hand -> tilt hint', !r.rotR.match && /Tilt your right fingers/.test(r.rotR.hint || ''), r.rotR.hint);
  check('one hand missing -> visibility hint', r.one.reason === 'count' && /one hand/.test(r.one.hint), r.one.hint);
  check('no hands -> visibility hint', r.none.reason === 'count' && /can't see your hands/.test(r.none.hint), r.none.hint);
  check('no page errors (geometry)', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ---------- B. full session flow, tip memory, and accuracy check (synthetic frames)
{
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(base);
  await page.addScriptTag({ content: helpers });
  const r = await page.evaluate(async () => {
    const M = window.MTTT, S = window.synth, q = (s) => document.querySelector(s);
    M.settings.voice = false;                     // text bubbles only, so the test runs fast
    M.state.running = true;                       // pretend the camera is on; frames come from the feeder below
    const poseA = [S(0.45, 0.6, 0.12, 1, 0), S(0.90, 0.6, 0.12, 1, 0)];
    const poseB = [S(0.55, 0.6, 0.12, 0, 0), S(0.80, 0.6, 0.12, 0, 0)];
    const wrongA = [S(0.45, 0.85, 0.12, 1, 0), S(0.90, 0.6, 0.12, 1, 0)];
    M.craft = { name: 'Test knot', steps: [{ id: 'a', name: 'Hold the cord apart', hands: poseA, photo: '' }, { id: 'b', name: 'Pinch the loop', hands: poseB, photo: '' }] };
    let feed = wrongA;
    const timer = setInterval(() => M.onFrame(typeof feed === 'function' ? feed() : feed, performance.now()), 33);
    const waitFor = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await window.sleep(50); } return false; };
    const out = {};

    // Session 1
    q('#elder-name').value = 'Mrs Lin';
    q('#btn-start').click();
    out.started = await waitFor(() => M.state.session && M.state.session.phase === 'doing', 6000);
    out.noTipFirstTime = q('#tipcard').classList.contains('hidden');
    out.hinted = await waitFor(() => M.results.hintDelays.length >= 1, 5000);
    out.hintText = q('#bubble').textContent;
    out.dwell = M.results.hintDelays[0] && M.results.hintDelays[0].dwellMs;
    feed = poseA;
    out.teachShown = await waitFor(() => M.state.session.phase === 'teach' && !q('#teach').classList.contains('hidden'), 8000);
    q('#teach-input').value = 'Pull the left cord tight first, so the knot will not loosen.';
    q('#btn-tip-keep').click();
    out.tipSaved = M.tips.length === 1 && M.tips[0].learner === 'Mrs Lin' && M.tips[0].stepId === 'a';
    out.step2 = await waitFor(() => M.state.session.i === 1 && M.state.session.phase === 'doing', 8000);
    feed = poseB;
    out.teach2 = await waitFor(() => M.state.session.phase === 'teach', 8000);
    q('#btn-tip-skip').click();
    out.done = await waitFor(() => M.state.session.phase === 'done' && !q('#story').classList.contains('hidden'), 6000);
    out.storyTips = q('#story-tips').textContent;

    // Session 2, same learner: the saved tip must come back at step 1.
    feed = wrongA;
    q('#btn-start').click();
    out.tipRecalled = await waitFor(() => !q('#tipcard').classList.contains('hidden'), 3000);
    out.tipText = q('#tip-text').textContent;
    out.introLine = q('#bubble').textContent;
    // A different learner must not see Mrs Lin's tip.
    q('#btn-stop').click();
    q('#elder-name').value = 'Mr Chen';
    q('#btn-start').click();
    await window.sleep(300);
    out.otherLearnerSeesTip = !q('#tipcard').classList.contains('hidden');
    q('#btn-stop').click();
    out.persisted = JSON.parse(localStorage.getItem('mttt.tips.v1') || '[]').length;

    // Accuracy check: the feeder obeys the instruction, so agreement should be 100%.
    const before = M.results.trials.length;
    q('#eval-n').value = 4;
    feed = () => {
      const e = M.state.evalRun;
      if (!e || !e.step) return wrongA;
      return e.target === 'correct' ? e.step.hands : [S(0.3, 0.3, 0.12, 0.5, 60), S(0.95, 0.9, 0.12, 0.5, -60)];
    };
    q('#btn-eval').click();
    out.evalDone = await waitFor(() => !M.state.evalRun && M.results.trials.length === before + 4, 30000);
    out.summary = M.summary();
    clearInterval(timer);
    return out;
  });
  check('session starts and reaches the doing phase', r.started);
  check('no tip card in the first session', r.noTipFirstTime);
  check('a wrong pose produces a hint after the dwell time', r.hinted && r.dwell >= 1500 && r.dwell < 2200, `"${r.hintText}" after ${r.dwell} ms`);
  check('a correct pose completes the step and opens teach-back', r.teachShown);
  check('confirmed tip is saved with learner and step', r.tipSaved);
  check('session advances to step 2', r.step2);
  check('step 2 completes; skipping a tip is allowed', r.teach2);
  check('session finishes with a story card listing the tip', r.done && /Pull the left cord tight/.test(r.storyTips));
  check('next session recalls the tip for the same learner', r.tipRecalled && /Pull the left cord tight/.test(r.tipText) && /Last time you taught me/.test(r.introLine) && !/\.\./.test(r.introLine), r.introLine);
  check('another learner does not get that tip', r.otherLearnerSeesTip === false);
  check('tip is persisted in local storage', r.persisted === 1);
  check('accuracy check runs and agrees when the instruction is followed', r.evalDone && r.summary.accuracy === 1, JSON.stringify(r.summary));
  check('tracking rate is reported', r.summary.trackingRate > 0.9, String(r.summary.trackingRate));
  check('no page errors (flow)', errors.length === 0, errors.join(' | '));
  await page.close();
}

// ---------- C. the vendored hand model loads and runs offline on camera frames
{
  const ctx = await browser.newContext({ permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [], external = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (q) => { if (!q.url().startsWith(base) && !q.url().startsWith('blob:') && !q.url().startsWith('data:')) external.push(q.url()); });
  await page.goto(base);
  await page.click('#btn-camera');
  let ok = false;
  try {
    await page.waitForFunction(() => window.MTTT.state.lastFrameAt > 0 && window.MTTT.state.fps > 0, null, { timeout: 60000 });
    ok = true;
  } catch (e) { /* reported below */ }
  const info = await page.evaluate(() => ({ badge: document.querySelector('#badge').textContent, fps: window.MTTT.state.fps, w: document.querySelector('#overlay').width }));
  check('hand model loads from the local vendor folder and processes frames', ok, JSON.stringify(info));
  check('no requests leave the machine', external.length === 0, external.slice(0, 3).join(' '));
  check('no page errors (camera)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
