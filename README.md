# My Turn to Teach

A craft companion for elder care. An elder learns a hand craft with gentle, real-time hints, then the roles flip: the elder teaches the AI a personal tip, the system saves it once confirmed, and offers it back in the next session.

Entry for the **ASUS UGen AI League** · Battlefield Lightning (ASUS UGen300) · Theme: Everyday AI.

This repository holds the **Stage I laptop prototype**. It simulates the planned on-device pipeline in a web browser so the idea can be tried with nothing more than a laptop and its webcam.

## Run it

Camera access needs a local web server (opening `index.html` directly from disk is not reliable).

```bash
# in this folder
python3 -m http.server 8000        # Windows: py -m http.server 8000
```

Then open <http://localhost:8000> in Chrome or Edge and allow the camera.

No install step and no build step. Hand tracking runs from the files in `vendor/` and works with the network unplugged.

## Use it

1. **Record the demo.** Hold the hand position for one step, press *Record step*, keep still for the countdown. Repeat for each step. This is the only "training" the system needs: no dataset, no model compilation.
2. **Session.** Enter the learner's name and press *Start session*. The app shows each step, watches both hands, and speaks one short hint when the pose drifts. When a step is done it asks for the learner's tip, reads it back, and saves it after a "yes". Run a second session with the same name to hear the tip come back.
3. **Accuracy check.** The app asks for a step done correctly, or wrongly on purpose, and compares its own judgement with what it asked for.
4. **Results.** Three numbers for the proposal: frames with the hands tracked, steps judged correctly, and hint delay. *Download results.json* saves the raw data.

Settings under the video: *Mirror view* (on for a laptop webcam), *Camera* position (changes the wording of up/down hints), *Strictness*, and *Voice*.

## How it works

```
camera ─▶ hand landmarks (21 points per hand) ─▶ pose descriptor ─▶ compare with the recorded demo
                                                                      │
                               match held 0.8 s ─▶ step done ─▶ teach-back ─▶ confirmed tip saved
                               wrong for 1.5 s  ─▶ one short spoken hint
```

- **Pose descriptor.** Each hand is translated to its wrist and scaled by its own size, so the same pose matches anywhere in the frame and at any distance. Two-hand steps also store where the left wrist sits relative to the right.
- **Comparison.** Mean point-to-point distance per hand, plus the relative-position error, each divided by a threshold. A score of 1.00 or less passes.
- **Hints.** The largest error picks one template sentence ("Lift your left hand a little."). Geometry decides right or wrong; language only phrases it.
- **Tip memory.** A confirmed tip is stored as a small record (learner, craft, step, text, date) and looked up by step in the next session. No model is retrained.
- **Privacy.** Video frames are processed in memory and discarded. Nothing is uploaded. The only stored image is the small reference photo the instructor records for each step.

## Stage I simulation versus the Stage II device

| Part | This prototype (laptop) | Stage II (ASUS UGen300, Hailo-10H) |
|---|---|---|
| Hand landmarks | MediaPipe Hands in the browser (WebAssembly), `modelComplexity 0` | `hand_landmark_lite` from the Hailo Model Zoo, the same model family |
| Finding the hands | MediaPipe palm detector | Wrist points from a pose model (no palm detector is listed for Hailo-10H) |
| Pose comparison, hint choice, tip memory | JavaScript in this repo | Same logic on the host CPU |
| Hint wording | Fixed templates | Templates, optionally rephrased by a small LLM on the accelerator |
| Speech to text | Browser speech service (needs a connection) | Whisper on the accelerator, offline |
| Text to speech | Browser voices | Host CPU |

The numbers this prototype reports are an upper bound for the device: a failure here would be a failure there, and a pass here still has to be confirmed on the UGen300.

## Known limits

- The check looks at hand pose, not at the cord itself. Steps whose hands look alike cannot be told apart yet.
- Fingers hidden by the material or by the other hand reduce tracking.
- Speech recognition is set to English and depends on the browser.
- Thresholds were set by reasoning and by synthetic tests, then exposed as the *Strictness* slider. They have not been tuned on a large set of real sessions.

## Tests

```bash
npm install playwright
node tests/run.mjs
```

The tests feed synthetic 21-point hands through the same code path as the camera. They cover the pose comparison, every hint template, the full session flow, tip recall across sessions, the accuracy check, and that the hand model loads from `vendor/` with no outside requests. They do not test tracking of real hands; that is what the Accuracy check tab is for.

## Files

- `index.html`, `style.css`, `app.js`: the prototype.
- `vendor/mediapipe-hands/`: MediaPipe Hands 0.4 (Apache License 2.0, Google), included so the demo runs offline.
- `tests/run.mjs`: automated checks.
