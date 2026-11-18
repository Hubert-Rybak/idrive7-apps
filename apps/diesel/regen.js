'use strict';
/**
 * regen.js - the particulate filter's regenerations as the Diesel app follows them: running or not, the regeneration
 * point, a log of each one and the soot over the last 1,000 km.
 *
 *   const rg = new Regen({ file, log });            // file: data/diesel.json (null = in memory, the demo's)
 *   rg.feed({ soot, sinceKm, tDpf, pid8b, rgnNum, loadPct, avgStart, avgEnd, regens, odo1, engine }, t)
 *   rg.state() -> { phase: 'active' | 'due' | 'ok' | 'unknown', by: 'flag' | 'heat' | null, requested, threshold,
 *                   thresholdBy: 'load' | 'average' | 'learned' | 'typical', load (0..1+), nextKm, run: { t0, s, km, soot0,
 *                   progress, peak } | null }
 *   rg.log     -> [{ t0, t1, s, km, interval, soot0, soot1, peak, result: 'complete' | 'stopped' }], newest first
 *   rg.samples -> [[distance km, soot g], ...] over the last HIST_KM
 *   rg.onEvent(fn) -> fn('start' | 'complete' | 'stopped', entry)
 *
 * Running: the engine unit's own flag (after-treatment status, OBD PID 8B bit 0: DDE 8 only) once it has been seen
 * at 0 too (a flag stuck at 1 is no flag), else heat: the exhaust before the filter at REGEN_C or more for HOT_MS,
 * until it stays under COOL_C for HOT_MS. Done: the distance since the last successful regeneration starts again
 * from 0 (BMW's own marker of a successful one), within SETTLE_MS of the end; else it counts as stopped.
 * Regeneration point: the soot against the DDE's own load % (5371), else its average soot at a regeneration's start
 * (4B52), else the median of the starts seen here, else TYPICAL_G.
 * Distance: the app's own, from the distance since the last regeneration (steps forward; after a reset, the new
 * value), so the soot chart has an axis without an odometer.
 */
const fs = require('fs');

const REGEN_C = 500, COOL_C = 420, HOT_MS = 30000, SETTLE_MS = 180000;
const TYPICAL_G = 24, END_G = 2, HIST_KM = 1000, SAMPLE_KM = 2, SAMPLE_G = 0.5, LOG_MAX = 30, SAVE_MS = 60000;
const isNum = (x) => typeof x === 'number' && isFinite(x);

function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}
function median(a) { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }

class Regen {
    constructor(opts) {
        this.file = opts && opts.file;
        this.log0 = (opts && opts.log) || { info() {}, warn() {} };
        this.listeners = [];
        this.reset();
        this.load();
    }
    reset() {
        this.dist = 0;                 // km, the app's own distance axis
        this.lastSince = null;         // the last distance since the last regeneration (km)
        this.samples = [];             // [[dist, soot]]
        this.log = [];                 // newest first
        this.run = null;               // the regeneration running: { t0, d0, since0, soot0, peak, by }
        this.ending = null;            // ended, not yet told done or stopped: { entry, t }
        this.seen0 = { pid8b: false, rgnNum: false };
        this.hotT = 0; this.coolT = 0; this.hot = false; this.latch = false;
        this.thrLoad = null;           // the regeneration point from the load % (smoothed)
        this.last = {};                // the last values fed
        this.dirty = false; this.savedT = 0;
    }
    onEvent(fn) { this.listeners.push(fn); }
    emit(what, e) { this.listeners.forEach((fn) => { try { fn(what, e); } catch (x) { this.log0.warn('regen event: ' + x); } }); }

    load() {
        if (!this.file) return;
        let s;
        try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return; }
        if (!s || s.v !== 1) return;
        this.dist = isNum(s.dist) ? s.dist : 0;
        this.lastSince = isNum(s.lastSince) ? s.lastSince : null;
        this.samples = Array.isArray(s.samples) ? s.samples.filter((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1])) : [];
        this.log = Array.isArray(s.log) ? s.log.filter((e) => e && isNum(e.t0)).slice(0, LOG_MAX) : [];
        this.run = s.run && isNum(s.run.t0) ? s.run : null;
        this.ending = s.ending && s.ending.entry && isNum(s.ending.t) ? s.ending : null;
        this.seen0 = Object.assign({ pid8b: false, rgnNum: false }, s.seen0);
        this.thrLoad = isNum(s.thrLoad) ? s.thrLoad : null;
    }
    save(force) {
        if (!this.file || !this.dirty) return;
        const now = Date.now();
        if (!force && now - this.savedT < SAVE_MS) return;
        this.savedT = now; this.dirty = false;
        try {
            writeWhole(this.file, JSON.stringify({ v: 1, dist: Math.round(this.dist * 1000) / 1000, lastSince: this.lastSince, samples: this.samples,
                log: this.log, run: this.run, ending: this.ending, seen0: this.seen0, thrLoad: this.thrLoad }));
        } catch (e) { this.log0.warn('diesel log: ' + e); }
    }

    /** The values read (null / undefined = not read), at time t (ms). */
    feed(v, t) {
        t = isNum(t) ? t : Date.now();
        const L = this.last = Object.assign({}, this.last, v);
        // ---- the app's distance, from the distance since the last regeneration
        if (isNum(v.sinceKm)) {
            const reset = this.lastSince !== null && v.sinceKm < this.lastSince - 0.5;
            if (this.lastSince !== null) {
                const step = reset ? v.sinceKm : v.sinceKm - this.lastSince;
                if (step > 0 && step < 50) { this.dist += step; this.dirty = true; }
            }
            if (reset && this.lastSince >= 1) this.done(t, v.sinceKm);
            this.lastSince = v.sinceKm;
        }
        // ---- soot samples over the last HIST_KM
        if (isNum(v.soot)) {
            const p = this.samples[this.samples.length - 1];
            if (!p || this.dist - p[0] >= SAMPLE_KM || Math.abs(v.soot - p[1]) >= SAMPLE_G) {
                this.samples.push([Math.round(this.dist * 10) / 10, Math.round(v.soot * 100) / 100]);
                while (this.samples.length && this.samples[0][0] < this.dist - HIST_KM) this.samples.shift();
                if (this.samples.length > 800) this.samples.splice(0, this.samples.length - 800);
                this.dirty = true;
            }
        }
        // ---- the regeneration point from the load %
        if (isNum(v.loadPct) && isNum(v.soot) && v.loadPct >= 15 && v.soot >= 2) {
            const thr = v.soot * 100 / v.loadPct;
            if (thr >= 5 && thr <= 80) { this.thrLoad = this.thrLoad === null ? thr : this.thrLoad * 0.8 + thr * 0.2; this.dirty = true; }
        }
        // ---- flags: a flag counts once it has been seen at 0 (else it may be stuck, or mean something else)
        if (isNum(v.pid8b) && (v.pid8b & 1) === 0 && !this.seen0.pid8b) { this.seen0.pid8b = true; this.dirty = true; }
        if (isNum(v.rgnNum) && v.rgnNum === 0 && !this.seen0.rgnNum) { this.seen0.rgnNum = true; this.dirty = true; }
        // ---- heat before the filter (only with the engine running)
        const temp = isNum(v.tDpf) ? v.tDpf : null;
        if (temp !== null && L.engine !== false) {
            if (temp >= REGEN_C) { this.coolT = 0; if (!this.hotT) this.hotT = t; if (t - this.hotT >= HOT_MS) this.hot = true; }
            else if (temp < COOL_C) { this.hotT = 0; if (!this.coolT) this.coolT = t; if (t - this.coolT >= HOT_MS) this.hot = false; }
            else { if (!this.hot) this.hotT = 0; this.coolT = 0; }            // in between: keeps what it was
        }
        if (L.engine === false) { this.hotT = 0; this.coolT = 0; this.hot = false; }
        // ---- running?
        const flagOn = this.seen0.pid8b && isNum(L.pid8b) ? (L.pid8b & 1) === 1 : null;
        const on = L.engine === false ? false : flagOn !== null ? flagOn : this.hot;
        const by = flagOn !== null ? 'flag' : 'heat';
        // (after a regeneration was done, a new one only once it has read as not running: the heat lingers)
        if (!on) this.latch = false;
        if (on && !this.run && !this.latch) this.begin(t, by);
        else if (!on && this.run) this.end(t);
        if (this.run) {
            if (temp !== null && (!isNum(this.run.peak) || temp > this.run.peak)) this.run.peak = Math.round(temp);
            if (isNum(v.soot)) this.run.soot = v.soot;
        }
        // ---- an ended one not told done: stopped after SETTLE_MS
        if (this.ending && t - this.ending.t > SETTLE_MS) this.finish('stopped');
        this.save(false);
    }

    begin(t, by) {
        const L = this.last;
        this.run = { t0: t, d0: this.dist, since0: isNum(L.sinceKm) ? L.sinceKm : null, soot0: isNum(L.soot) ? L.soot : null, soot: L.soot, peak: null, by };
        if (this.ending) this.finish('stopped');
        this.dirty = true;
        this.log0.info('regeneration started (' + by + '), soot ' + (isNum(L.soot) ? L.soot.toFixed(1) + ' g' : '?') + ', ' + (isNum(L.sinceKm) ? L.sinceKm.toFixed(0) + ' km' : '?') + ' since the last');
        this.emit('start', this.run);
        this.save(true);
    }
    end(t) {
        const r = this.run, L = this.last;
        this.run = null;
        const entry = { t0: r.t0, t1: t, s: Math.round((t - r.t0) / 1000), km: Math.round((this.dist - r.d0) * 10) / 10, interval: r.since0,
            soot0: r.soot0, soot1: isNum(L.soot) ? L.soot : null, peak: r.peak, by: r.by, result: null };
        this.ending = { entry, t };
        this.dirty = true;
    }
    /** The distance since the last regeneration started again from 0: the one running (or just ended) was done. */
    done(t) {
        if (this.run) { this.end(t); this.latch = true; }
        if (this.ending) this.finish('complete');
    }
    finish(result) {
        const e = this.ending.entry;
        this.ending = null;
        e.result = result;
        if (result === 'complete' && isNum(this.last.soot)) e.soot1 = this.last.soot;
        this.log.unshift(e);
        if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
        this.dirty = true;
        this.log0.info('regeneration ' + result + ': ' + e.s + ' s, ' + e.km + ' km, soot ' + (isNum(e.soot0) ? e.soot0.toFixed(1) : '?') + ' -> ' + (isNum(e.soot1) ? e.soot1.toFixed(1) : '?') + ' g, peak ' + (e.peak || '?') + ' °C');
        this.emit(result, e);
        this.save(true);
    }

    /** The regeneration point (g) and where it came from. */
    threshold() {
        if (isNum(this.thrLoad)) return { g: this.thrLoad, by: 'load' };
        const a = this.last.avgStart;
        if (isNum(a) && a >= 5 && a <= 80) return { g: a, by: 'average' };
        const starts = this.log.filter((e) => e.result === 'complete' && isNum(e.soot0) && e.soot0 >= 5).slice(0, 5).map((e) => e.soot0);
        if (starts.length) return { g: median(starts), by: 'learned' };
        return { g: TYPICAL_G, by: 'typical' };
    }

    state() {
        const L = this.last, thr = this.threshold();
        const load = isNum(L.loadPct) ? L.loadPct / 100 : isNum(L.soot) ? L.soot / thr.g : null;
        const requested = this.seen0.rgnNum && isNum(L.rgnNum) && L.rgnNum > 0;
        const nextKm = isNum(L.avgKm) && isNum(L.sinceKm) ? Math.max(0, L.avgKm - L.sinceKm) : null;
        let phase = 'unknown', run = null;
        if (this.run) {
            phase = 'active';
            const r = this.run, end = isNum(L.avgEnd) && L.avgEnd >= 0 && L.avgEnd < 15 ? L.avgEnd : END_G;
            const progress = isNum(r.soot0) && isNum(L.soot) ? Math.max(0, Math.min(1, (r.soot0 - L.soot) / Math.max(1, r.soot0 - end))) : null;
            run = { t0: r.t0, s: Math.round((Date.now() - r.t0) / 1000), km: Math.round((this.dist - r.d0) * 10) / 10, soot0: r.soot0, progress, peak: r.peak, by: r.by };
        } else if (load !== null) phase = load >= 1 || requested ? 'due' : 'ok';
        return { phase, by: this.run ? this.run.by : null, requested, threshold: thr.g, thresholdBy: thr.by, load, nextKm, run };
    }
}

Regen.REGEN_C = REGEN_C; Regen.COOL_C = COOL_C; Regen.HOT_MS = HOT_MS; Regen.SETTLE_MS = SETTLE_MS; Regen.TYPICAL_G = TYPICAL_G; Regen.HIST_KM = HIST_KM;
module.exports = { Regen };
