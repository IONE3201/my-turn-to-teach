// Records the demo video: card stills + a scripted run of the prototype with simulated hands.
//   PLAYWRIGHT_MODULE=<path to playwright> node video/record.mjs
// Writes build/title.png, build/problem.png, build/outro.png, build/demo.webm, build/cues.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const build = path.join(here, 'build');
fs.mkdirSync(build, { recursive: true });
const durations = JSON.parse(fs.readFileSync(path.join(build, 'audio', 'durations.json'), 'utf8'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(root, u === '/' ? '/index.html' : u);
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const W = 1280, H = 800;
const browser = await chromium.launch();

// ---- stills
{
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto(base + 'video/cards.html');
  for (const id of ['title', 'problem', 'outro']) {
    await page.evaluate((id) => { document.querySelectorAll('.card').forEach((c) => c.classList.toggle('show', c.id === id)); }, id);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(build, `${id}.png`) });
  }
  await page.close();
}

// ---- demo recording
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: build, size: { width: W, height: H } } });
const page = await ctx.newPage();
const t0 = Date.now();
const cues = [];
const cue = (id) => cues.push({ id, at: (Date.now() - t0) / 1000 });
const sleep = (ms) => page.waitForTimeout(ms);
const sec = (id) => durations[id] * 1000;

await page.goto(base);
await page.addScriptTag({ content: fs.readFileSync(path.join(here, 'driver.js'), 'utf8') });
await page.evaluate(() => window.DRIVER.boot());

// s2: the prototype, then recording a step
cue('s2_proto');
await sleep(sec('s2_proto') + 300);
cue('s2_record');
await page.evaluate(() => window.DRIVER.setFeed('poseA'));
await page.fill('#craft-name', 'Simple knot');
await page.fill('#step-name', 'Hold the cord apart');
await page.click('#btn-record');
await sleep(4600);
await page.evaluate(() => window.DRIVER.setFeed('poseB'));
await page.fill('#step-name', 'Pinch the loop');
await page.click('#btn-record');
await sleep(Math.max(4600, sec('s2_record') - 4600 + 800));

// s3: session, wrong pose, hint
await page.click('[data-tab=session]');
await page.fill('#elder-name', 'Mrs Lin');
await page.evaluate(() => window.DRIVER.setFeed('wrongA'));
cue('s3_session');
await page.click('#btn-start');
await page.waitForFunction(() => window.MTTT.results.hintDelays.length >= 1, null, { timeout: 20000 });
await sleep(Math.max(2500, sec('s3_session') - 9000));

// s4: correct pose -> teach back
await page.evaluate(() => window.DRIVER.setFeed('poseA'));
await page.waitForFunction(() => window.MTTT.state.session && window.MTTT.state.session.phase === 'teach', null, { timeout: 20000 });
cue('s4_done');
await sleep(sec('s4_done') + 200);
await page.evaluate(() => window.DRIVER.typeInto('#teach-input', 'Pull the left cord tight first, so the knot will not loosen.'));
await sleep(3200);
cue('s4_keep');
await page.click('#btn-tip-keep');
await sleep(sec('s4_keep'));

// step 2 quickly, skip the tip, finish -> story card
await page.waitForFunction(() => window.MTTT.state.session && window.MTTT.state.session.i === 1 && window.MTTT.state.session.phase === 'doing', null, { timeout: 20000 });
await page.evaluate(() => window.DRIVER.setFeed('poseB'));
await page.waitForFunction(() => window.MTTT.state.session && window.MTTT.state.session.phase === 'teach', null, { timeout: 20000 });
await sleep(1200);
await page.click('#btn-tip-skip');
await page.waitForFunction(() => window.MTTT.state.session && window.MTTT.state.session.phase === 'done', null, { timeout: 20000 });
await page.evaluate(() => window.DRIVER.storyPhoto());
cue('s5_story');
await sleep(sec('s5_story') + 1500);

// s6: second session, tip recalled
await page.evaluate(() => window.DRIVER.setFeed('wrongA'));
cue('s6_recall');
await page.click('#btn-start');
await sleep(sec('s6_recall') + 2500);
await page.click('#btn-stop');

// s7: accuracy check (6 trials) and results
await page.click('[data-tab=eval]');
await page.fill('#eval-n', '6');
await page.evaluate(() => window.DRIVER.setFeed('obey'));
cue('s7_eval');
await page.click('#btn-eval');
await page.waitForFunction(() => !window.MTTT.state.evalRun && window.MTTT.results.trials.length >= 6, null, { timeout: 60000 });
await sleep(800);
await page.click('[data-tab=results]');
await sleep(4500);

await page.evaluate(() => window.DRIVER.stop());
await page.close();
const video = await (await ctx.pages()[0] || page).video?.();
await ctx.close();
// Playwright names the file itself; rename the newest .webm in build/.
const webms = fs.readdirSync(build).filter((f) => f.endsWith('.webm')).map((f) => ({ f, t: fs.statSync(path.join(build, f)).mtimeMs })).sort((a, b) => b.t - a.t);
fs.renameSync(path.join(build, webms[0].f), path.join(build, 'demo.webm'));
fs.writeFileSync(path.join(build, 'cues.json'), JSON.stringify({ total: (Date.now() - t0) / 1000, cues }, null, 1));
await browser.close();
server.close();
console.log('recorded', cues);
