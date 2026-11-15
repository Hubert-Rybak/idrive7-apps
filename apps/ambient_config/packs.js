'use strict';
/**
 * packs.js - light packs for the Packs tab (only for use on private property): named sequences of timed light steps,
 * the built-in ones and your own, run by strobe.js (Strobe.runPack) on the same ways to the lamps as the strobe.
 *
 * A pack (JSON, the same for the built-in ones and those in the app's data folder, data/packs/*.json, one pack or a
 * list of them a file):
 *
 *   { "id": "double", "title": "Double flash", "description": "Two short high beam flashes",
 *     "loop": false,                                    (optional: round and round until Stop, at most 60 s)
 *     "steps": [ <step>, ... ] }
 *
 * A step, one of:
 *   { "fn": "high" | ["high", "fog"], "ms": 120 }     light functions on for ms (30-1000; the body controller ends
 *                                                     them by itself); several are sent one after the other
 *   { "output": "FL_L" | ["FL_L", "FL_R"], "on": true }  the body controller's lamp outputs (cars without light
 *                                                     functions); every output a pack touched is handed back at its end
 *   { "disco": 8000, "fast": false }                  the body controller's own light show for ms (at most 15 s)
 *   { "wait": "500ms" }                               nothing for a while
 *   { "seq": [ <step>, ... ], "repeat": 4 }           steps repeated as a group
 * and on any of them:
 *   "delay": "1.5s" | "1500ms" | 500                  from this step's start to the next one's (a number: ms). The
 *                                                     link takes ~200 ms a request, so less is "as fast as it goes"
 *   "repeat": 3                                       the step this many times (1-20)
 *
 * Light functions: high, indL, indR, fog, cornL, cornR, brake, ess (brake flash), rearFog, reverse, parkL, parkR.
 *
 *   validate(raw) -> { ok, pack, errors }    pack: { id, title, description, loop, steps: flat steps, needs, ms }
 *   parseDelay('1.5s') -> 1500 (null: not a delay)
 *   BUILT_IN, load(dir, log) -> [pack]
 */
const fs = require('fs');
const path = require('path');
const { F: FN } = require('./strobe');

const OUTPUTS = { FL_L: 0x07, FL_R: 0x08 };     // the body controller's lamp outputs a pack may switch (the high beams)
const FN_MIN_MS = 30, FN_MAX_MS = 1000;         // a light function's time (the body controller ends it by itself)
const DISCO_MAX_MS = 15000;                     // the body controller's own show: at most this long a step

const MAX_DELAY_MS = 10000;
const MAX_REPEAT = 20;
const MAX_STEPS = 400;                // flat steps (a seq repeated counts each time)
const REQ_MS = 200;                   // what a request takes on the head unit's link (for the time a pack takes)

/** '1.5s', '1500ms', '500' or 500 -> ms; null when it is not a delay (or over 10 s). */
function parseDelay(v) {
    if (v === undefined || v === null || v === '') return 0;
    let ms = null;
    if (typeof v === 'number') ms = v;
    else {
        const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*$/i.exec(String(v));
        if (m) ms = parseFloat(m[1]) * (m[2] && m[2].toLowerCase() === 's' ? 1000 : 1);
    }
    if (ms === null || !isFinite(ms) || ms < 0 || ms > MAX_DELAY_MS) return null;
    return Math.round(ms);
}

const list = (v) => (Array.isArray(v) ? v : [v]);

/** One raw step -> flat steps (errors pushed with where they are). */
function flatten(raw, where, errors, out, depth) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(where + ': not a step'); return; }
    const repeat = raw.repeat === undefined ? 1 : raw.repeat;
    if (!(Number.isInteger(repeat) && repeat >= 1 && repeat <= MAX_REPEAT)) { errors.push(where + ': repeat must be 1-' + MAX_REPEAT); return; }
    const delayMs = parseDelay(raw.delay);
    if (delayMs === null) { errors.push(where + ': delay "' + raw.delay + '" is not 0-10 s (e.g. 1.5s, 1500ms, 500)'); return; }
    const kinds = ['fn', 'output', 'disco', 'wait', 'seq'].filter((k) => raw[k] !== undefined);
    if (kinds.length !== 1) { errors.push(where + ': needs exactly one of fn, output, disco, wait, seq'); return; }
    const kind = kinds[0];
    let step = null;
    if (kind === 'seq') {
        if (depth > 3) { errors.push(where + ': seq nested too deep'); return; }
        if (!Array.isArray(raw.seq) || !raw.seq.length) { errors.push(where + ': seq must be a list of steps'); return; }
        for (let r = 0; r < repeat; r++) {
            raw.seq.forEach((s, i) => flatten(s, where + '.seq[' + i + ']', r === 0 ? errors : [], out, depth + 1));
            if (out.length > MAX_STEPS) break;
        }
        return;
    }
    if (kind === 'fn') {
        const fns = list(raw.fn);
        const bad = fns.filter((f) => FN[f] === undefined);
        if (!fns.length || bad.length) { errors.push(where + ': no light function ' + (bad.join(', ') || '(none)')); return; }
        const ms = raw.ms === undefined ? 150 : raw.ms;
        if (!(typeof ms === 'number' && ms >= FN_MIN_MS && ms <= FN_MAX_MS)) { errors.push(where + ': ms must be ' + FN_MIN_MS + '-' + FN_MAX_MS); return; }
        step = { job: 'fn', fns, ms: Math.round(ms) };
    } else if (kind === 'output') {
        const outs = list(raw.output);
        const bad = outs.filter((o) => OUTPUTS[o] === undefined);
        if (!outs.length || bad.length) { errors.push(where + ': no lamp output ' + (bad.join(', ') || '(none)')); return; }
        if (typeof raw.on !== 'boolean') { errors.push(where + ': output needs "on": true or false'); return; }
        step = { job: 'output', outputs: outs, on: raw.on };
    } else if (kind === 'disco') {
        const ms = raw.disco;
        if (!(typeof ms === 'number' && ms >= 500 && ms <= DISCO_MAX_MS)) { errors.push(where + ': disco must be 500-' + DISCO_MAX_MS + ' ms'); return; }
        step = { job: 'disco', ms: Math.round(ms), fast: raw.fast === true };
    } else {
        const ms = parseDelay(raw.wait);
        if (ms === null || ms === 0) { errors.push(where + ': wait "' + raw.wait + '" is not 0-10 s'); return; }
        step = { job: 'wait', ms };
    }
    // a disco step waits for its show to run unless it says otherwise; a wait is its own delay
    const d = raw.delay !== undefined ? delayMs : step.job === 'disco' || step.job === 'wait' ? step.ms : 0;
    for (let r = 0; r < repeat; r++) out.push(Object.assign({ delayMs: d }, step));
}

/** The time a flat step takes on the car (ms): its delay, or its requests if they take longer. */
function stepMs(s) {
    const n = s.job === 'fn' ? s.fns.length : s.job === 'output' ? s.outputs.length : s.job === 'disco' ? 1 : 0;
    return Math.max(s.delayMs, n * REQ_MS);
}

function validate(raw) {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, pack: null, errors: ['not a pack'] };
    const id = typeof raw.id === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(raw.id) ? raw.id : null;
    if (!id) errors.push('id: 1-40 letters, digits, _ . : -');
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 40) : null;
    if (!title) errors.push('title missing');
    if (raw.loop !== undefined && typeof raw.loop !== 'boolean') errors.push('loop: true or false');
    const steps = [];
    if (!Array.isArray(raw.steps) || !raw.steps.length) errors.push('steps: a list of steps');
    else raw.steps.forEach((s, i) => flatten(s, 'steps[' + i + ']', errors, steps, 0));
    if (steps.length > MAX_STEPS) errors.push('more than ' + MAX_STEPS + ' steps');
    if (!errors.length && !steps.some((s) => s.job !== 'wait')) errors.push('nothing but waits');
    if (errors.length) return { ok: false, pack: null, errors, id, title };
    const needs = [];
    if (steps.some((s) => s.job === 'fn')) needs.push('fn');
    if (steps.some((s) => s.job === 'output')) needs.push('outputs');
    if (steps.some((s) => s.job === 'disco')) needs.push('disco');
    const pack = {
        id, title, description: typeof raw.description === 'string' ? raw.description.slice(0, 120) : '',
        loop: raw.loop === true, steps, needs, ms: steps.reduce((n, s) => n + stepMs(s), 0),
    };
    return { ok: true, pack, errors: [] };
}

// the built-in packs: made here from the light functions' notes (strobe.js), nothing taken from another app's packs
const RAW = [
    { id: 'once', title: 'Flash once', description: 'One high beam flash', steps: [{ fn: 'high', ms: 150, delay: 400 }] },
    { id: 'double', title: 'Double flash', description: 'Two short high beam flashes', steps: [{ fn: 'high', ms: 120, delay: 320, repeat: 2 }] },
    { id: 'triple', title: 'Triple flash', description: 'Three short high beam flashes', steps: [{ fn: 'high', ms: 100, delay: 260, repeat: 3 }] },
    { id: 'headlight', title: 'Headlight strobe', description: 'High beam and front fog together, eight times',
        steps: [{ fn: ['high', 'fog'], ms: 100, delay: 250, repeat: 8 }] },
    { id: 'police', title: 'Police', description: 'Left, right, then high beam bursts',
        steps: [{ seq: [{ fn: 'cornL', ms: 100, repeat: 3 }, { fn: 'cornR', ms: 100, repeat: 3 }, { fn: 'high', ms: 80, repeat: 2 }], repeat: 3 }] },
    { id: 'racing', title: 'Racing', description: 'Indicators left and right, then a high beam burst',
        steps: [{ seq: [{ fn: 'indL', ms: 150 }, { fn: 'indR', ms: 150 }], repeat: 4 }, { fn: 'high', ms: 80, repeat: 4 }, { wait: 300 }] },
    { id: 'ghost', title: 'Ghost', description: 'A slow sweep across the front and back again',
        steps: [{ seq: [{ fn: 'parkL', ms: 400, delay: 450 }, { fn: 'cornL', ms: 400, delay: 450 }, { fn: 'high', ms: 400, delay: 450 },
            { fn: 'cornR', ms: 400, delay: 450 }, { fn: 'parkR', ms: 400, delay: 450 }, { fn: 'cornR', ms: 400, delay: 450 },
            { fn: 'high', ms: 400, delay: 450 }, { fn: 'cornL', ms: 400, delay: 450 }], repeat: 2 }] },
    { id: 'rear', title: 'Rear lights', description: 'Brake, reverse, rear fog and the brake flash',
        steps: [{ fn: 'brake', ms: 200, delay: 350, repeat: 3 }, { fn: 'reverse', ms: 400, delay: 500 }, { fn: 'rearFog', ms: 400, delay: 500 },
            { fn: 'ess', ms: 600, delay: 800 }] },
    { id: 'all', title: 'Every light', description: 'Each outside light in turn, twice',
        steps: [{ seq: ['high', 'cornL', 'cornR', 'fog', 'indL', 'indR', 'parkL', 'parkR', 'brake', 'reverse', 'rearFog', 'ess'].map((f) => ({ fn: f, ms: 150 })), repeat: 2 }] },
    { id: 'disco', title: 'Body controller show', description: 'The body controller\'s own show on every lamp output, 8 s',
        steps: [{ disco: 8000 }] },
    { id: 'outputs', title: 'High beam outputs', description: 'Left and right high beam in turn (cars without light functions)',
        steps: [{ seq: [{ output: 'FL_L', on: true, delay: 200 }, { output: 'FL_L', on: false }, { output: 'FL_R', on: true, delay: 200 },
            { output: 'FL_R', on: false }], repeat: 4 }] },
];
const BUILT_IN = RAW.map((r) => {
    const v = validate(r);
    if (!v.ok) throw new Error('built-in pack ' + r.id + ': ' + v.errors.join('; '));
    return Object.assign(v.pack, { builtIn: true });
});

/**
 * Your own packs: every data/packs/*.json (a pack or a list of them), checked; one that is not right is listed with
 * what is wrong (errors) and cannot run. Their ids are kept apart from the built-in ones ("my:" in front).
 */
function load(dir, log) {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort(); } catch (e) { return out; }
    const seen = new Set();
    for (const f of files) {
        let raw;
        try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) {
            out.push({ id: 'my:' + f, title: f, description: '', errors: ['not JSON: ' + (e && e.message || e)], steps: [], needs: [], ms: 0 });
            continue;
        }
        list(raw).forEach((r, i) => {
            const v = validate(r);
            const id = 'my:' + (v.pack ? v.pack.id : v.id || f + '#' + i);
            if (seen.has(id)) { if (log) log.warn('packs: ' + f + ': ' + id + ' twice, the second left out'); return; }
            seen.add(id);
            if (v.ok) out.push(Object.assign(v.pack, { id, file: f }));
            else {
                if (log) log.warn('packs: ' + f + ': ' + v.errors.join('; '));
                out.push({ id, title: v.title || f, description: '', errors: v.errors, file: f, steps: [], needs: [], ms: 0 });
            }
        });
    }
    return out;
}

module.exports = { parseDelay, validate, load, stepMs, BUILT_IN, OUTPUTS, FN_MIN_MS, FN_MAX_MS, DISCO_MAX_MS, MAX_DELAY_MS, MAX_REPEAT, MAX_STEPS, REQ_MS };
