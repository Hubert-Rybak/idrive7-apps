'use strict';
/**
 * Diesel - the diesel particulate filter (DPF) and the rest of a diesel's exhaust after-treatment.
 *
 * DRAFT: layout with demo values only (the engine unit's identifiers come next).
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');

const W = 1600, H = 520;
const GO = '#2fd27a';
const TABS = ['DPF', 'Regenerations', 'AdBlue', 'Engine'];

/* Demo values: a filter two thirds of the way to its next regeneration, or (DIESEL_MOCK=regen) one regenerating. */
function demo(now) {
    const regen = process.env.DIESEL_MOCK === 'regen', s = now / 1000;
    const hist = [];
    // soot over the last 1,000 km: a sawtooth, a regeneration about every 440 km
    for (let km = 0; km <= 1000; km += 10) {
        const k = (km + 500) % 440, burn = k > 425;
        hist.push([km - 1000, burn ? 24 * (1 - (k - 425) / 15) : 1.5 + k / 425 * 22.5]);
    }
    return regen ? {
        demo: true, soot: 9.6 + Math.sin(s) * 0.1, sootModel: 10.4, sootMax: 24, ash: 38, ashMax: 150, dp: 21, tIn: 612 + Math.sin(s / 3) * 6, tOut: 648, tHist: hist.map((p, i) => 300 + (i > 85 ? (i - 85) * 22 : 0)),
        dpHist: hist.map((p) => 8 + p[1] * 0.5), state: 'regen', progress: 0.62, regenMin: 11, regenKm: 13, startSoot: 24.6,
        sinceKm: 0, lastKm: 438, lastMin: 19, count: 287, avgKm: 441, hist,
    } : {
        demo: true, soot: 16.4 + Math.sin(s) * 0.1, sootModel: 17.1, sootMax: 24, ash: 38, ashMax: 150, dp: 14 + Math.sin(s / 2), tIn: 318 + Math.sin(s / 3) * 6, tOut: 296, tHist: hist.map((p, i) => 280 + 40 * Math.sin(i / 6)),
        dpHist: hist.map((p) => 8 + p[1] * 0.5), state: 'normal', sinceKm: 312, sinceMin: 274, lastKm: 438, lastMin: 19, count: 287, avgKm: 441, hist,
    };
}

mgu.run({
    async start(ctx) {
        const { ui, settings } = ctx;
        let page = 0;
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');

        /** One status row on the right: label left, value + unit right, a dim note under the label. */
        function row(cv, t, y, label, value, unit, note, color) {
            cv.text(label, 952, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            if (note) cv.text(note, 952, y + 26, 20, t.dim);
            const uw = unit ? cv.textWidth(' ' + unit, 24) : 0;
            cv.text(value, 1552 - uw, y + 20, 44, color || t.text, { align: 'right', font: 'num' });
            if (unit) cv.text(' ' + unit, 1552, y + 20, 24, t.dim, { align: 'right' });
        }

        function renderDpf(cv, t, d, now) {
            // ---- soot: the regeneration starts near sootMax
            const max = Math.ceil(d.sootMax * 1.25 / 5) * 5;
            G.segBar(cv, t, 24, G.TOP, 880, 225, {
                label: 'Soot', value: d.soot, unit: 'g', decimals: 1, min: 0, max, step: 1, scale: { every: 5 },
                zones: [{ from: d.sootMax * 0.9, to: max, color: 'warn' }], marks: [{ value: d.sootMax, color: t.warn }],
            });
            const pct = Math.round(d.soot / d.sootMax * 100);
            cv.text('model ' + d.sootModel.toFixed(1) + ' g  ·  ' + pct + ' % of the regeneration point', 130, G.TOP + 41, 20, t.dim);

            // ---- tiles: ash, differential pressure, filter temperature
            const ty = G.TOP + 242, th = 226;
            G.stat(cv, t, 24, ty, 284, th, { label: 'Ash', value: d.ash, unit: 'g', decimals: 0, size: 64, sub: Math.round(d.ash / d.ashMax * 100) + ' % of the limit' });
            G.stat(cv, t, 322, ty, 284, th, { label: 'Pressure drop', value: d.dp, unit: 'hPa', decimals: 0, size: 64, history: d.dpHist, sub: 'across the filter' });
            G.stat(cv, t, 620, ty, 284, th, { label: 'Filter in', value: T(d.tIn), unit: tU(), decimals: 0, size: 64, history: d.tHist.map(T), sub: 'out ' + Math.round(T(d.tOut)) + tU(),
                zones: [{ from: T(550), to: T(900), color: 'warn' }] });

            // ---- regeneration status
            const sp = G.panel(cv, t, 928, G.TOP, 648, 468, null);
            const regen = d.state === 'regen', due = d.state === 'due';
            const st = regen ? 'REGENERATING' : due ? 'REGENERATION DUE' : 'FILTER OK', col = regen ? t.warn : due ? t.warn : GO;
            cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.22));
            if (regen) cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.12 + 0.1 * Math.sin(now / 300)));
            cv.text(st, 1252, 114, 38, col, { align: 'center', font: 'bold', spacing: 3 });
            if (regen) {
                cv.text('Keep driving, don\'t switch the engine off', 952, 170, 24, t.text, { font: 'bold' });
                cv.text('SOOT BURNT', 952, 214, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(Math.round(d.progress * 100) + ' %', 1552, 216, 30, t.text, { align: 'right', font: 'num' });
                cv.roundRect(952, 228, 600, 12, 6, t.track);
                cv.rampRect(952, 228, Math.max(12, 600 * d.progress), 12, 6, [t.warn, GO], 952, 600);
                row(cv, t, 280, 'RUNNING FOR', String(d.regenMin), 'min', d.regenKm + ' km  ·  started at ' + d.startSoot.toFixed(1) + ' g');
            } else {
                row(cv, t, 170, 'SINCE LAST REGENERATION', String(d.sinceKm), 'km', Math.floor(d.sinceMin / 60) + ' h ' + d.sinceMin % 60 + ' min of driving');
                row(cv, t, 240, 'LAST REGENERATION', String(d.lastMin), 'min', 'after ' + d.lastKm + ' km');
                row(cv, t, 310, 'REGENERATIONS', String(d.count), '', 'one every ' + d.avgKm + ' km on average');
            }
            // ---- soot over the last 1,000 km (the app's own log): the sawtooth of the regenerations
            const gy = 384, gh = sp.y + sp.h - gy - 22;
            cv.text('SOOT, LAST 1000 KM', 952, gy - 8, 18, t.dim, { font: 'bold', spacing: 1.5 });
            G.chart(cv, t, 952, gy, 600, gh, { xMin: -1000, xMax: 0, yMin: 0, yMax: 30, yStep: 10, xStep: 250, padLeft: 34, xUnit: 'km',
                marks: [{ y: d.sootMax, color: t.warn }], series: [{ pts: d.hist, color: t.accent2 || t.accent, fill: true }] });
        }

        function renderRegens(cv, t) {
            G.panel(cv, t, 24, G.TOP, 1552, 468, 'Regenerations');
            const rows = [
                ['18.11.  08:42', '438 km', '19 min', '21 km', '24.6 to 1.8 g', { text: 'complete', color: GO }],
                ['14.11.  17:05', '452 km', '17 min', '19 km', '24.2 to 1.5 g', { text: 'complete', color: GO }],
                ['11.11.  07:58', '211 km', '6 min', '4 km', '23.9 to 18.0 g', { text: 'stopped', color: t.warn }],
                ['10.11.  18:20', '447 km', '21 min', '24 km', '24.8 to 1.9 g', { text: 'complete', color: GO }],
                ['06.11.  12:31', '430 km', '18 min', '22 km', '24.1 to 1.6 g', { text: 'complete', color: GO }],
            ];
            G.table(cv, t, 48, 110, 1500, [{ label: 'Started', w: 260 }, { label: 'Interval', w: 220, align: 'right' }, { label: 'Took', w: 200, align: 'right' },
                { label: 'Distance', w: 200, align: 'right' }, { label: 'Soot', w: 340, align: 'right' }, { label: '', w: 280, align: 'right', font: 'bold' }], rows, { rowH: 56, size: 28 });
            cv.text('287 regenerations in the engine unit  ·  one every 441 km on average  ·  1 of the last 5 stopped early', 48, 488, 22, t.dim);
        }

        function renderAdblue(cv, t) {
            G.segBar(cv, t, 24, G.TOP, 880, 225, { label: 'AdBlue', value: 11.8, unit: 'l', decimals: 1, min: 0, max: 16, step: 1, scale: { every: 4 },
                marks: [{ value: 3, color: t.crit }] });
            cv.text('range about 5,900 km', 170, G.TOP + 41, 20, t.dim);
            const ty = G.TOP + 242, th = 226;
            G.stat(cv, t, 24, ty, 284, th, { label: 'NOx in', value: 312, unit: 'ppm', size: 64, sub: 'before the SCR' });
            G.stat(cv, t, 322, ty, 284, th, { label: 'NOx out', value: 14, unit: 'ppm', size: 64, sub: 'after the SCR' });
            G.stat(cv, t, 620, ty, 284, th, { label: 'SCR', value: T(286), unit: tU(), size: 64, sub: 'catalyst temperature' });
            G.panel(cv, t, 928, G.TOP, 648, 468, 'Conversion');
            G.ring(cv, t, 1252, 260, 130, { value: 95.5, max: 100, decimals: 0, unit: '%', label: 'NOx removed', color: GO });
            cv.text('dosing 1.9 ml/min', 1252, 470, 24, t.dim, { align: 'center' });
        }

        function render() {
            const t = ctx.theme(), now = Date.now(), d = demo(now);
            const cv = ctx.canvas(W, H).clear(t.bg);
            [() => renderDpf(cv, t, d, now), () => renderRegens(cv, t), () => renderAdblue(cv, t), () => null][page]();
            G.frame(cv, t, TABS, page, [d.demo && { text: 'DEMO' }]);
            return ui.image('MAIN_GFX', cv);
        }
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });
        const p = Number(process.env.DIESEL_PAGE || 0); if (p) page = p;
        ctx.loop('MAIN', 4, render);
        render().catch((e) => ctx.log.warn('first render: ' + e));
    },
});
