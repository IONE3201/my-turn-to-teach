// Injected into the prototype page by record.mjs. Feeds simulated hand landmarks into the
// same code path the camera uses (window.MTTT.onFrame) and draws a simple table scene behind them.
(function () {
  const M = window.MTTT;
  const ov = document.querySelector('#overlay');
  const g = ov.getContext('2d');
  const Wc = 960, Hc = 720;

  function synth(cx, cy, size, open, rotDeg) {
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
  }
  // Pose = parameters for two hands: [cx, cy, size, open, rot] each.
  const POSES = {
    poseA: [[0.45, 0.68, 0.12, 1, 0], [0.90, 0.68, 0.12, 1, 0]],
    poseB: [[0.52, 0.66, 0.12, 0.05, 15], [0.83, 0.66, 0.12, 0.05, -15]],
    wrongA: [[0.45, 0.92, 0.12, 1, 0], [0.90, 0.68, 0.12, 1, 0]],
    messy: [[0.30, 0.35, 0.12, 0.5, 60], [0.98, 0.90, 0.12, 0.5, -60]],
  };
  let current = POSES.wrongA.map((h) => h.slice()), target = POSES.wrongA, mode = 'fixed';
  let timer = null, t = 0;

  function lerp(a, b, k) { return a + (b - a) * k; }
  function frame() {
    t += 1;
    if (mode === 'obey') {
      const e = M.state.evalRun;
      if (e && e.step) {
        const want = e.target === 'correct' ? (e.step.id === 'a' ? POSES.poseA : POSES.poseB) : POSES.messy;
        target = want;
      }
    }
    for (let h = 0; h < 2; h++) for (let i = 0; i < 5; i++) current[h][i] = lerp(current[h][i], target[h][i], 0.12);
    // natural wobble so it does not look frozen
    const list = current.map((p, h) => synth(p[0] + 0.004 * Math.sin(t / 17 + h), p[1] + 0.004 * Math.cos(t / 23 + h * 2), p[2], p[3], p[4] + 1.5 * Math.sin(t / 29 + h)));
    // scene: warm table, a cord between the hands, a label
    const grad = g.createLinearGradient(0, 0, 0, Hc);
    grad.addColorStop(0, '#6b4f36'); grad.addColorStop(1, '#4a3626');
    g.fillStyle = grad; g.fillRect(0, 0, Wc, Hc);
    g.fillStyle = 'rgba(255,245,230,0.10)'; g.fillRect(60, 430, Wc - 120, 240);
    const L = list[0][0], R = list[1][0];
    g.strokeStyle = '#C9402A'; g.lineWidth = 9; g.lineCap = 'round';
    g.beginPath(); g.moveTo(L[0] * Hc, L[1] * Hc - 20);
    g.bezierCurveTo(L[0] * Hc + 120, L[1] * Hc - 160, R[0] * Hc - 120, R[1] * Hc - 160, R[0] * Hc, R[1] * Hc - 20);
    g.stroke();
    g.fillStyle = 'rgba(42,38,34,0.7)'; g.fillRect(Wc - 372, Hc - 44, 360, 32);
    g.fillStyle = '#FBF7F0'; g.font = '18px sans-serif'; g.fillText('Simulated hand input (synthetic landmarks)', Wc - 362, Hc - 22);
    M.onFrame(list, performance.now());
  }

  window.DRIVER = {
    boot() {
      localStorage.clear();
      M.settings.voice = false; M.settings.mirror = true; M.settings.view = 'front';
      M.state.running = true;
      ov.width = Wc; ov.height = Hc;
      document.querySelector('#btn-camera').textContent = 'Camera running';
      document.querySelector('#btn-camera').disabled = true;
      // make recorded steps deterministic ids so the driver can tell them apart
      const origPush = Array.prototype.push;
      timer = setInterval(frame, 33);
      // patch step ids after recording
      setInterval(() => { M.craft.steps.forEach((s, i) => { s.id = i === 0 ? 'a' : 'b'; }); }, 200);
    },
    setFeed(name) { mode = name === 'obey' ? 'obey' : 'fixed'; if (POSES[name]) target = POSES[name]; },
    typeInto(sel, text) {
      const el = document.querySelector(sel);
      let i = 0; el.value = '';
      const id = setInterval(() => { i += 2; el.value = text.slice(0, i); if (i >= text.length) { el.value = text; clearInterval(id); } }, 60);
    },
    storyPhoto() {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const q = c.getContext('2d'); q.drawImage(ov, 0, 0, 640, 480);
      document.querySelector('#story-photo').src = c.toDataURL('image/jpeg', 0.8);
    },
    stop() { clearInterval(timer); },
  };
})();
