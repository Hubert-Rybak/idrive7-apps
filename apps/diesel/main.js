'use strict';
/**
 * Diesel - the diesel particulate filter (DPF) and the rest of a B47 / B57's exhaust after-treatment, read from the
 * engine unit (DDE) over the head unit's diagnostic link, reading only (reader.js, kit/readonly-diag.js).
 *
 *   DPF            soot against the regeneration point, ash, the pressure drop, the heat into the filter; FILTER OK /
 *                  REGENERATION DUE / REGENERATING (keep driving) with the soot burnt; since the last one, the next one,
 *                  the count; the soot over the last 1,000 km (the app's own log)
 *   Regenerations  each one the app saw (when, the distance before it, how long, soot before / after, done or stopped),
 *                  else the engine unit's own last five (odometer, intervals)
 *   AdBlue         level and range, NOx before / after the SCR catalyst, how much of it goes, the catalyst's heat
 *   Engine         the EGR valves OPEN / CLOSED (how far, the target), air mass, rail pressure, boost, the injectors'
 *                  quantity corrections
 *   Details        every value with its identifier, the reply's bytes and why one has none: what the car really sends
 *
 * In the background (app.json autostart; regen.js): while the engine runs, the filter's values every 20 s (5 s during a
 * regeneration), so each regeneration is logged even with the app closed; nothing once the car is locked and left.
 * Optional: the ambient light flashes when a regeneration starts and ends (setting regenFlash, Ambient config's flash).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const Engine = require('./kit/engine');
const { Reader } = require('./reader');
const { Regen } = require('./regen');
const { DemoReader } = require('./demo');
const D = require('./dde');

const W = 1600, H = 520;
const GO = '#2fd27a', BLUE = '#81c4ff';
const TABS = ['DPF', 'Regenerations', 'AdBlue', 'Engine', 'Details'];
const DPF_KEYS = ['soot', 'sootMeas', 'sootSim', 'ash', 'dp', 'tDpf', 'tDpfSens', 'tDoc', 'sinceKm', 'sinceS', 'sinceL', 'regens', 'avgKm', 'lifeKm',
    'pid8b', 'rgnNum', 'loadPct', 'avgStart', 'avgEnd'];
const PAGE_KEYS = [
    DPF_KEYS,
    ['soot', 'tDpf', 'tDpfSens', 'sinceKm', 'regens', 'avgKm', 'pid8b', 'rgnNum', 'loadPct', 'avgStart', 'avgEnd'].concat(D.ODO),
    ['adLevel', 'adRange', 'adQual', 'adMass', 'noxIn', 'noxOut', 'scrT', 'tScr', 'scrEff'],
    ['egrHp', 'egrHpSet', 'egrLp', 'egrLpSet', 'egrRate', 'air', 'airSet', 'rail', 'railSet', 'boostAbs', 'boostSetAbs', 'ambient'].concat(D.INJ),
    Object.keys(D.VALUES),
];
const PAGE_MS = [2000, 5000, 2000, 1000, 2000];
// what the background follows while the engine runs: enough to see a regeneration start and end
const BG_KEYS = ['soot', 'tDpf', 'tDpfSens', 'sinceKm', 'pid8b', 'rgnNum', 'loadPct', 'avgKm', 'avgStart', 'avgEnd', 'regens'];
const BG_MS = 20000, BG_REGEN_MS = 5000, RUN_RPM = 400, TICK_MS = 1000;
const AMBIENT_FLASH = process.env.MGU_AMBIENT_FLASH || '/dev/shm/mgu-ambient-flash.json';
const FLASH = { start: [255, 140, 0], complete: [0, 230, 90], stopped: [255, 40, 40] };
const KM_MI = 0.621371;
const AD_DENSITY = 1090;              // g per litre of AdBlue (32.5 % urea)

// the Details page's names
const LABELS = {
    soot: 'Soot', sootMeas: 'Soot, measured', sootSim: 'Soot, model', ash: 'Ash', dp: 'Pressure drop', tDpf: 'Before the filter',
    tDpfSens: 'Before the filter, sensor', tDoc: 'Before the oxidation cat', sinceKm: 'Since the last regeneration', sinceS: 'Engine time since it',
    sinceL: 'Fuel since it', regens: 'Regenerations', avgKm: 'Average interval', odo1: 'Last regeneration at', odo2: 'The one before at',
    odo3: 'Third last at', odo4: 'Fourth last at', odo5: 'Fifth last at', lifeKm: 'Filter life left', rgnNum: 'Regeneration request',
    rgnLock: 'Regeneration lock', rgnIntr: 'Regeneration interrupted', pid8b: 'After-treatment status', loadPct: 'Load, regeneration point',
    avgStart: 'Average soot at a start', avgEnd: 'Average soot at an end', adRange: 'AdBlue range', adQual: 'AdBlue quality',
    adMass: 'AdBlue, engine unit', noxIn: 'NOx before the SCR', noxOut: 'NOx after the SCR', scrT: 'SCR catalyst', tScr: 'Before the SCR',
    scrEff: 'SCR conversion, average', adLevel: 'AdBlue level', egrHp: 'EGR, high pressure', egrHpSet: 'EGR high, target',
    egrLp: 'EGR, low pressure', egrLpSet: 'EGR low, target', egrRate: 'EGR rate', air: 'Air mass', airSet: 'Air mass, target', rail: 'Rail pressure',
    railSet: 'Rail pressure, target', boostAbs: 'Boost, absolute', boostSetAbs: 'Boost target, absolute', ambient: 'Ambient pressure',
    inj1: 'Injector 1', inj2: 'Injector 2', inj3: 'Injector 3', inj4: 'Injector 4', inj5: 'Injector 5', inj6: 'Injector 6',
};

function writeWhole(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}
const two = (n) => (n < 10 ? '0' : '') + n;
/** 146240 -> '146,240' */
const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/* With or without the screen (autostart): the regenerations followed while the engine runs. */
async function background(bg) {
    const { settings, signals, log } = bg;
    const st = { rpm: null, left: false };
    const engine = new Engine({ settings, dataDir: bg.dataDir, log });
    const w = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn('diesel: ' + iface + ': ' + (e && e.message || e))) : null);
    w('de.bmw.infotainment.vehicle.CDS', {
        statusEngineSpeed2: (v) => { const r = v && v.actualValueRPMEngineCrankshaft; if (typeof r === 'number' && r !== 65535) st.rpm = r * 0.25; },
    });
    w(Engine.SIGNAL[0], engine.handlers());
    // the car locked and left (BMW's vehicle state 1..3): nothing read, so it can sleep
    w('de.bmw.infrastructure.VehicleCondition', {
        VehicleCondition: (v) => {
            const n = Car.conditionOf(v && v.statusConditionVehicle);
            if (n === undefined || st.left === (n <= 3)) return;
            st.left = n <= 3;
            log.info(st.left ? 'the car is locked and left: nothing read' : 'the car is in use again');
        },
    });
    const reader = new Reader({ signals, log, settings, canRead: () => !st.left, engineType: () => engine.detected() }).start();
    const regen = new Regen({ file: path.join(bg.dataDir, 'diesel.json'), log });
    regen.onEvent((what) => {
        if (settings.get('regenFlash') !== true) return;
        try { writeWhole(AMBIENT_FLASH, JSON.stringify({ rgb: FLASH[what], ms: 1500 }) + '\n'); } catch (e) { log.warn('ambient flash: ' + e); }
    });
    let fedAt = 0, ran = false;
    setInterval(() => {
        const running = typeof st.rpm === 'number' && st.rpm >= RUN_RPM;
        reader.want('bg', running && settings.get('demo') !== 'on' ? BG_KEYS : [], regen.run ? BG_REGEN_MS : BG_MS);
        if (!reader.diesel) return;
        if (ran && !running) regen.feed({ engine: false });
        ran = running;
        if (reader.lastGood <= fedAt) return;
        fedAt = reader.lastGood;
        const v = {};
        ['soot', 'sinceKm', 'pid8b', 'rgnNum', 'loadPct', 'avgStart', 'avgEnd', 'avgKm', 'regens'].forEach((k) => { v[k] = reader.value(k); });
        v.pid8b = reader.raw('pid8b'); v.rgnNum = reader.raw('rgnNum');
        v.tDpf = reader.value('tDpf') !== null ? reader.value('tDpf') : reader.value('tDpfSens');
        v.engine = typeof st.rpm === 'number' ? running : undefined;
        regen.feed(v);
    }, TICK_MS);
    process.on('exit', () => regen.save(true));
    return { reader, regen, engine, st };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings } = ctx;
        const bgs = ctx.background || await background(ctx);
        const reader = bgs.reader, regen = bgs.regen;
        let page = 0, detail = 0, detailT = Date.now();

        // ---- demo: Always, or Auto while the link isn't there and nothing has answered
        let demoReader = null, demoRegen = null;
        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !reader.replied && !reader.link.available);
        const src = () => {
            if (!demo()) return reader;
            if (!demoReader) { demoReader = new DemoReader(); demoRegen = new Regen({}); demoReader.seed(demoRegen); }
            return demoReader;
        };
        const rg = () => (demo() ? (src(), demoRegen) : regen);

        // ---- units
        const F = () => settings.get('tempUnit') === 'f', MI = () => settings.get('distUnit') === 'mi';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null), tU = () => (F() ? '°F' : '°C');
        const Dk = (km) => (G.isNum(km) ? (MI() ? km * KM_MI : km) : null), dU = () => (MI() ? 'mi' : 'km');

        // ---- what to read: the page's values while it is shown
        let visible = ui.isVisible ? ui.isVisible('MAIN') : true;
        const wanted = () => reader.want('ui', visible && !demo() ? PAGE_KEYS[page] : [], PAGE_MS[page]);
        const turn = (i) => { page = i; detail = 0; detailT = Date.now(); wanted(); return render(); };
        ui.onClick('BTN_PAGE', () => turn((page + 1) % TABS.length));
        ui.onClick('BTN_PREV', () => turn((page + TABS.length - 1) % TABS.length));
        // the current tab tapped again: read its page again now (unless the tap closed Settings)
        if (ctx.onTab) ctx.onTab((i, closedSheet) => { if (i !== page) return turn(i); if (!closedSheet) reader.refresh(); return render(); });
        if (ui.onVisible) ui.onVisible((name, on) => { if (name === 'MAIN') { visible = on; wanted(); } });
        settings.onChange(() => wanted());
        wanted();

        // ---- short traces (the last 2 minutes) for the tiles
        const trace = { t: [], dp: [], tIn: [] };
        let traceT = 0;
        function sample(d) {
            const now = Date.now();
            if (now - traceT < 1000) return;
            traceT = now;
            trace.t.push(now); trace.dp.push(d.dp); trace.tIn.push(d.tIn);
            while (trace.t.length > 120) { trace.t.shift(); trace.dp.shift(); trace.tIn.shift(); }
            if (demo()) {
                // the demo's tracker is fed here (the background feeds the real one)
                const s = src(), v = {};
                ['soot', 'sinceKm', 'loadPct', 'avgStart', 'avgEnd', 'avgKm', 'regens', 'tDpf'].forEach((k) => { v[k] = s.value(k); });
                v.pid8b = s.raw('pid8b'); v.rgnNum = s.raw('rgnNum'); v.engine = true;
                demoRegen.feed(v);
            }
        }

        /** Everything the pages draw, from the engine unit (or the demo) and the regeneration tracker. */
        function data() {
            const s = src(), r = rg(), st = r.state(), v = (k) => s.value(k), why = (k) => s.why(k);
            const tIn = v('tDpf') !== null ? v('tDpf') : v('tDpfSens');
            const amb = v('ambient') !== null ? v('ambient') : 1013;
            const boost = v('boostAbs') !== null ? (v('boostAbs') - amb) / 1000 : null;
            const boostT = v('boostSetAbs') !== null ? (v('boostSetAbs') - amb) / 1000 : null;
            // injectors: six when the fifth or sixth answers with something, else four (B47)
            const six = [v('inj5'), v('inj6')].some((x) => G.isNum(x) && Math.abs(x) > 0.005);
            const inj = D.INJ.slice(0, six ? 6 : 4).map((k) => v(k));
            const noxIn = v('noxIn'), noxOut = v('noxOut'), scrT = v('scrT');
            const conv = G.isNum(noxIn) && G.isNum(noxOut) && noxIn >= 20 && G.isNum(scrT) && scrT >= 180 ? G.clamp((1 - noxOut / noxIn) * 100, 0, 100) : null;
            const adLevel = v('adLevel') !== null ? v('adLevel') : v('adMass') !== null ? v('adMass') / AD_DENSITY : null;
            return {
                demo: demo(), status: s.status(), diesel: s.diesel, family: s.family, verified: s.verified, index: s.index, scr: s.scr, scrIndex: s.scrIndex,
                v, why,
                soot: v('soot'), sootMeas: v('sootMeas'), sootSim: v('sootSim'), sootMax: st.threshold, thrBy: st.thresholdBy, load: st.load,
                ash: v('ash'), lifeKm: v('lifeKm'), dp: v('dp'), tIn, tDoc: v('tDoc'),
                phase: st.phase, by: st.by, requested: st.requested, run: st.run, nextKm: st.nextKm,
                sinceKm: v('sinceKm'), sinceS: v('sinceS'), sinceL: v('sinceL'), regens: v('regens'), avgKm: v('avgKm'),
                hist: r.samples.map((p) => [p[0] - r.dist, p[1]]), log: r.log, odo: D.ODO.map((k) => v(k)),
                adLevel, adLevelEst: v('adLevel') === null && v('adMass') !== null, adRange: v('adRange'), adQual: v('adQual'), noxIn, noxOut, scrT,
                tScr: v('tScr'), scrEff: v('scrEff'), conv,
                egrHp: { pos: v('egrHp'), target: v('egrHpSet'), why: why('egrHp') }, egrLp: { pos: v('egrLp'), target: v('egrLpSet'), why: why('egrLp') },
                egrRate: v('egrRate'), air: v('air'), airTarget: v('airSet'), rail: v('rail'), railTarget: v('railSet'), boost, boostTarget: boostT, inj,
            };
        }

        /* ---------- drawing ---------- */

        /** A status row on the right: label left, value + unit right, a dim note under the label. */
        function row(cv, t, y, label, value, unit, note, color) {
            cv.text(label, 952, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            if (note) cv.text(note, 952, y + 26, 20, t.dim);
            const uw = unit ? cv.textWidth(' ' + unit, 24) : 0;
            cv.text(value, 1552 - uw, y + 20, 44, value === '--' ? t.dim : color || t.text, { align: 'right', font: 'num' });
            if (unit) cv.text(' ' + unit, 1552, y + 20, 24, t.dim, { align: 'right' });
        }
        const num = (x, dec) => (G.isNum(x) ? x.toFixed(dec || 0) : '--');
        const big = (x) => (G.isNum(x) ? thousands(x) : '--');
        const hm = (sec) => (G.isNum(sec) ? Math.floor(sec / 3600) + ' h ' + two(Math.floor(sec % 3600 / 60)) + ' min' : '');

        /** The whole page as one message (not a diesel, no link...). */
        function message(cv, t, head, line1, line2) {
            G.panel(cv, t, 24, G.TOP, 1552, 468, null);
            cv.text(head, 800, 250, 34, t.warn, { align: 'center', font: 'bold' });
            if (line1) cv.text(line1, 800, 304, 24, t.dim, { align: 'center' });
            if (line2) cv.text(line2, 800, 344, 22, t.dim, { align: 'center' });
        }

        function renderDpf(cv, t, d, now) {
            // ---- soot: the regeneration starts at sootMax
            const max = Math.max(10, Math.ceil(d.sootMax * 1.25 / 5) * 5);
            G.segBar(cv, t, 24, G.TOP, 880, 225, {
                label: 'Soot', value: d.soot, unit: 'g', decimals: 1, min: 0, max, step: max > 40 ? 2 : 1, scale: { every: max > 40 ? 10 : 5 },
                zones: [{ from: d.sootMax * 0.9, to: max, color: 'warn' }], marks: [{ value: d.sootMax, color: t.warn }],
            });
            const pct = G.isNum(d.load) ? Math.round(d.load * 100) + ' % of the regeneration point' + (d.thrBy === 'typical' ? ' (typical)' : '') : '';
            const sub = G.isNum(d.soot) ? (G.isNum(d.sootSim) ? 'model ' + d.sootSim.toFixed(1) + ' g' + (pct ? '  ·  ' : '') : '') + pct : d.why('soot');
            cv.text(sub, 130, G.TOP + 41, 20, t.dim);

            // ---- tiles: ash, the pressure drop, the heat into the filter
            const ty = G.TOP + 242, th = 226;
            G.stat(cv, t, 24, ty, 284, th, { label: 'Ash', value: d.ash, unit: 'g', decimals: 0, size: 64,
                sub: G.isNum(d.lifeKm) ? 'filter life ' + big(Dk(d.lifeKm)) + ' ' + dU() : G.isNum(d.ash) ? 'oil ash, stays in' : d.why('ash') });
            G.stat(cv, t, 322, ty, 284, th, { label: 'Pressure drop', value: d.dp, unit: 'hPa', decimals: 0, size: 64, history: trace.dp,
                sub: G.isNum(d.dp) ? 'across the filter' : d.why('dp') });
            G.stat(cv, t, 620, ty, 284, th, { label: 'Filter in', value: T(d.tIn), unit: tU(), decimals: 0, size: 64, history: trace.tIn.map(T),
                sub: G.isNum(d.tDoc) ? 'oxi cat in ' + Math.round(T(d.tDoc)) + tU() : d.why('tDpf'), zones: [{ from: T(Regen.REGEN_C), to: T(1200), color: 'warn' }] });

            // ---- the regeneration
            const sp = G.panel(cv, t, 928, G.TOP, 648, 468, null);
            const regen = d.phase === 'active', due = d.phase === 'due';
            const st = regen ? 'REGENERATING' : due ? 'REGENERATION DUE' : d.phase === 'ok' ? 'FILTER OK' : 'NO DATA YET';
            const col = regen || due ? t.warn : d.phase === 'ok' ? GO : t.dim;
            cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.22));
            if (regen) cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.12 + 0.1 * Math.sin(now / 300)));
            cv.text(st, 1252, 114, 38, col, { align: 'center', font: 'bold', spacing: 3 });
            if (regen) {
                const r = d.run;
                cv.text('Keep driving, don\'t switch the engine off', 952, 170, 24, t.text, { font: 'bold' });
                cv.text('SOOT BURNT', 952, 214, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(G.isNum(r.progress) ? Math.round(r.progress * 100) + ' %' : '--', 1552, 216, 30, t.text, { align: 'right', font: 'num' });
                cv.roundRect(952, 228, 600, 12, 6, t.track);
                if (G.isNum(r.progress) && r.progress > 0) cv.rampRect(952, 228, Math.max(12, 600 * r.progress), 12, 6, [t.warn, GO], 952, 600);
                row(cv, t, 280, 'RUNNING FOR', String(Math.floor(r.s / 60)), 'min',
                    num(Dk(r.km), 0) + ' ' + dU() + (G.isNum(r.soot0) ? '  ·  started at ' + r.soot0.toFixed(1) + ' g' : '') + (r.by === 'heat' ? '  ·  by the heat' : ''));
            } else if (due) {
                cv.text(d.requested ? 'The engine has asked for one' : 'The soot is at the regeneration point', 952, 170, 24, t.text, { font: 'bold' });
                cv.text('20-30 min at a steady 60 km/h or more lets it run', 952, 202, 22, t.dim);
                row(cv, t, 250, 'SINCE LAST REGENERATION', big(Dk(d.sinceKm)), dU(), hm(d.sinceS) + (d.sinceS ? ' of driving' : ''));
            } else {
                row(cv, t, 170, 'SINCE LAST REGENERATION', big(Dk(d.sinceKm)), dU(), G.isNum(d.sinceS) ? hm(d.sinceS) + ' of driving' : d.why('sinceKm'));
                row(cv, t, 240, 'NEXT REGENERATION', G.isNum(d.nextKm) ? '~' + big(Dk(d.nextKm)) : '--', dU(), G.isNum(d.avgKm) ? 'from the average of ' + big(Dk(d.avgKm)) + ' ' + dU() : '');
                row(cv, t, 310, 'REGENERATIONS', big(d.regens), '', G.isNum(d.regens) ? 'successful, in the engine unit' : d.why('regens'));
            }
            // ---- the soot over the last 1,000 km (the app's own log): the sawtooth of the regenerations
            const gy = 384, gh = sp.y + sp.h - gy - 22, span = Dk(Regen.HIST_KM);
            cv.text('SOOT, LAST ' + Math.round(span) + ' ' + dU().toUpperCase(), 952, gy - 8, 18, t.dim, { font: 'bold', spacing: 1.5 });
            G.chart(cv, t, 952, gy, 600, gh, { xMin: -span, xMax: 0, yMin: 0, yMax: Math.max(30, Math.ceil(d.sootMax / 10 + 0.3) * 10), yStep: 10, xStep: MI() ? 200 : 250,
                padLeft: 34, xUnit: dU(), empty: 'logged as you drive', marks: [{ y: d.sootMax, color: t.warn }],
                series: [{ pts: d.hist.map((p) => [Dk(p[0]), p[1]]), color: t.accent2 || t.accent, fill: true }] });
        }

        function renderRegens(cv, t, d) {
            const p = G.panel(cv, t, 24, G.TOP, 1552, 468, 'Regenerations');
            const day = (ms) => { const a = new Date(ms); return a.getDate() + '.' + two(a.getMonth() + 1) + '.  ' + a.getHours() + ':' + two(a.getMinutes()); };
            if (d.log.length) {
                const rows = d.log.slice(0, 5).map((e) => [day(e.t0), G.isNum(e.interval) ? big(Dk(e.interval)) + ' ' + dU() : '--', Math.max(1, Math.round(e.s / 60)) + ' min',
                    num(Dk(e.km), 0) + ' ' + dU(), (G.isNum(e.soot0) ? e.soot0.toFixed(1) : '?') + '  to  ' + (G.isNum(e.soot1) ? e.soot1.toFixed(1) : '?') + ' g',
                    G.isNum(e.peak) ? Math.round(T(e.peak)) + tU() : '--', { text: e.result === 'complete' ? 'done' : 'stopped early', color: e.result === 'complete' ? GO : 'warn' }]);
                G.table(cv, t, 48, 104, 1500, [{ label: 'Started', w: 230 }, { label: 'After', w: 190, align: 'right' }, { label: 'Took', w: 160, align: 'right' },
                    { label: 'Distance', w: 180, align: 'right' }, { label: 'Soot', w: 300, align: 'right' }, { label: 'Peak', w: 170, align: 'right' },
                    { label: '', w: 270, align: 'right', font: 'bold' }], rows, { rowH: 54, size: 26 });
            } else {
                // nothing seen here yet: the engine unit's own last five (odometer at each, the distances between them)
                const odo = d.odo.filter(G.isNum);
                const rows = odo.map((km, i) => [i === 0 ? 'Last' : i === 1 ? 'The one before' : (i + 1) + ' back', big(Dk(km)) + ' ' + dU(),
                    i + 1 < odo.length ? big(Dk(km - odo[i + 1])) + ' ' + dU() : '--']);
                G.table(cv, t, 48, 104, 900, [{ label: 'Regeneration', w: 300 }, { label: 'At', w: 300, align: 'right' }, { label: 'After', w: 300, align: 'right' }],
                    rows, { rowH: 54, size: 26, empty: d.why('odo1') });
                cv.text('Each regeneration from now on is logged with', 1000, 160, 22, t.dim);
                cv.text('its time, soot and heat, also with the app closed.', 1000, 190, 22, t.dim);
            }
            const stopped = d.log.slice(0, 5).filter((e) => e.result !== 'complete').length;
            cv.text((G.isNum(d.regens) ? big(d.regens) + ' regenerations in the engine unit' : 'regenerations: ' + d.why('regens')) +
                (G.isNum(d.avgKm) ? '  ·  one every ' + big(Dk(d.avgKm)) + ' ' + dU() + ' on average' : '') +
                (stopped ? '  ·  ' + stopped + ' of the last ' + Math.min(5, d.log.length) + ' stopped early' : ''), 48, p.y + p.h - 22, 22, t.dim);
        }

        function renderAdblue(cv, t, d) {
            const none = !d.demo && d.why('adRange') === 'not on this car' && d.why('noxIn') === 'not on this car';
            if (none) return message(cv, t, 'No AdBlue system on this car', 'The engine unit has no SCR catalyst values (a B47 without AdBlue).');
            G.segBar(cv, t, 24, G.TOP, 880, 225, { label: 'AdBlue', value: d.adLevel, unit: 'l', decimals: 1, min: 0, max: 20, step: 1, scale: { every: 5 },
                marks: [{ value: 3, color: t.crit }] });
            const range = G.isNum(d.adRange) ? 'range about ' + big(Dk(d.adRange)) + ' ' + dU() : d.why('adRange');
            cv.text(range + (d.adLevelEst ? '  ·  level from the engine unit (estimate)' : G.isNum(d.adLevel) ? '' : '  ·  level: ' + d.why('adLevel')), 170, G.TOP + 41, 20, t.dim);
            const ty = G.TOP + 242, th = 226;
            G.stat(cv, t, 24, ty, 284, th, { label: 'NOx in', value: d.noxIn, unit: 'ppm', size: 64, sub: G.isNum(d.noxIn) ? 'before the SCR' : d.why('noxIn') });
            G.stat(cv, t, 322, ty, 284, th, { label: 'NOx out', value: d.noxOut, unit: 'ppm', size: 64, sub: G.isNum(d.noxOut) ? 'after the SCR' : d.why('noxOut') });
            G.stat(cv, t, 620, ty, 284, th, { label: 'SCR', value: T(d.scrT), unit: tU(), size: 64, sub: G.isNum(d.scrT) ? 'catalyst temperature' : d.why('scrT') });
            G.panel(cv, t, 928, G.TOP, 648, 468, 'Conversion');
            G.ring(cv, t, 1252, 250, 130, { value: d.conv, max: 100, decimals: 0, unit: '%', label: 'NOx removed now', color: GO });
            cv.text(G.isNum(d.scrEff) ? 'average ' + d.scrEff.toFixed(1) + ' %' + (G.isNum(d.adQual) ? '  ·  AdBlue quality ' + d.adQual.toFixed(1) + ' %' : '') :
                G.isNum(d.conv) ? '' : 'needs a warm catalyst and both NOx sensors', 1252, 470, 22, t.dim, { align: 'center' });
        }

        /**
         * An EGR valve seen along the flow: the pipe, its butterfly plate turning on a horizontal shaft (closed = the
         * plate fills the pipe, fully open = edge on), the gas let through glowing around it. open = 0..1 or null.
         */
        function valve(cv, t, cx, cy, r, open, col) {
            const known = G.isNum(open), f = known ? G.clamp(open, 0, 1) : 0;
            // the ring: how far open, 0..100 %
            cv.arc(cx, cy, r + 4, r + 16, 0, 360, t.track);
            if (known && f > 0.005) cv.arc(cx, cy, r + 4, r + 16, 0, f * 360, col, { round: true });
            cv.circle(cx, cy, r, withAlpha('#000000', 0.35));
            if (known && f > 0.02) cv.circle(cx, cy, r, withAlpha(col, 0.2 + 0.3 * f));
            // the plate: an ellipse as horizontal strips (quads), as high as the valve is closed (edge on when fully open)
            const rx = r - 3, ry = Math.max(3, rx * (1 - f)), N = 24, pc = known ? withAlpha('#c9d0da', 0.9) : withAlpha(t.tick, 0.5);
            const half = (y) => rx * Math.sqrt(Math.max(0, 1 - (y / ry) * (y / ry)));
            for (let k = 0; k < N; k++) {
                const y0 = -ry + 2 * ry * k / N, y1 = -ry + 2 * ry * (k + 1) / N, w0 = half(y0), w1 = half(y1);
                cv.quad([[cx - w0, cy + y0], [cx + w0, cy + y0], [cx + w1, cy + y1], [cx - w1, cy + y1]], pc);
            }
            cv.line(cx - r - 26, cy, cx + r + 26, cy, 5, t.tick);
            cv.circle(cx, cy, 7, t.dim);
        }

        /** One EGR valve with its state: OPEN / CLOSED, the opening and the engine unit's target. */
        function egr(cv, t, cx, label, v) {
            const has = G.isNum(v.pos), open = has && v.pos >= 3, col = open ? (t.accent2 || t.accent) : t.dim, absent = !has && v.why === 'not on this car';
            cv.text(label, cx, 104, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
            valve(cv, t, cx, 228, 92, has ? v.pos / 100 : null, col);
            cv.text(has ? (open ? 'OPEN' : 'CLOSED') : absent ? 'NOT FITTED' : '--', cx, 396, 40, has && open ? t.text : t.dim, { align: 'center', font: 'bold', spacing: 3 });
            if (has) {
                cv.text(String(Math.round(Math.max(0, v.pos))), cx - 10, 452, 44, t.text, { align: 'right', font: 'num' });
                cv.text('%', cx - 4, 452, 24, t.dim);
                if (G.isNum(v.target)) cv.text('target ' + Math.round(Math.max(0, v.target)) + ' %', cx + 40, 450, 22, t.dim);
            } else if (!absent) cv.text(v.why, cx, 446, 22, t.dim, { align: 'center' });
        }

        function renderEngine(cv, t, d) {
            const p = G.panel(cv, t, 24, G.TOP, 880, 468, 'EGR');
            egr(cv, t, 244, 'HIGH PRESSURE', d.egrHp);
            egr(cv, t, 684, 'LOW PRESSURE', d.egrLp);
            const line = (G.isNum(d.egrRate) ? 'exhaust gas let back in  ' + Math.round(d.egrRate) + ' %' : '') +
                (G.isNum(d.air) ? (G.isNum(d.egrRate) ? '  ·  ' : '') + 'air mass ' + Math.round(d.air) + (G.isNum(d.airTarget) ? ' of ' + Math.round(d.airTarget) : '') + ' mg/stroke' : '');
            cv.text(line, 464, p.y + p.h - 22, 20, t.dim, { align: 'center' });
            G.panel(cv, t, 928, G.TOP, 648, 468, 'Engine');
            G.bar(cv, t, 952, 92, 600, 96, { label: 'Rail pressure', value: d.rail, unit: 'bar', max: 2500, step: 500, peak: d.railTarget, decimals: 0 });
            G.bar(cv, t, 952, 200, 600, 96, { label: 'Boost', value: d.boost, unit: 'bar', decimals: 2, max: 3, step: 0.5, peak: d.boostTarget });
            cv.text('INJECTOR CORRECTION', 952, 340, 22, t.dim, { font: 'bold', spacing: 1.5 });
            const iw = cv.textWidth('INJECTOR CORRECTION', 22, { font: 'bold', spacing: 1.5 });
            cv.text('mg/stroke, at warm idle', 952 + iw + 14, 340, 20, t.dim);
            const zy = 400, n = d.inj.length, cw = 600 / n;
            cv.fillRect(952, zy, 600, 2, t.tick);
            d.inj.forEach((q, i) => {
                const x = 952 + i * cw + cw / 2, has = G.isNum(q), hgt = has ? G.clamp(q / 1.5, -1, 1) * 34 : 0, c = has && Math.abs(q) > 1 ? t.warn : t.accent2 || t.accent;
                if (has) cv.fillRect(x - 22, hgt > 0 ? zy - hgt : zy + 2, 44, Math.max(2, Math.abs(hgt)), c);
                cv.text(has ? (q > 0 ? '+' : '') + q.toFixed(1) : '--', x, 466, 24, has && Math.abs(q) > 1 ? t.warn : has ? t.text : t.dim, { align: 'center', font: 'bold' });
                cv.text(String(i + 1), x, 494, 18, t.dim, { align: 'center' });
            });
        }

        /** Every value with its identifier and the reply's bytes, 2 x 10 a page (the pages turn: tap, or every 8 s). */
        function renderDetails(cv, t, d) {
            const s = src(), rows = s.rows(), per = 20, pages = Math.max(1, Math.ceil(rows.length / per));
            if (!cv.own && Date.now() - detailT > 8000) { detail = (detail + 1) % pages; detailT = Date.now(); }
            detail = Math.min(detail, pages - 1);
            const p = G.panel(cv, t, 24, G.TOP, 1552, 468, 'Details' + (pages > 1 ? '  ' + (detail + 1) + '/' + pages : ''));
            const id = d.demo ? 'demo' : d.index ? 'engine unit ' + d.index + ' · ' + (d.family === 'other' ? 'not a diesel' : D.NAMES[d.family] || '?') + (d.verified ? '' : ' · unverified') : 'engine unit: not identified yet';
            const scr = d.scrIndex ? '  ·  AdBlue unit ' + d.scrIndex + (d.scr ? ' (' + d.scr.toUpperCase() + ')' : '') : '';
            cv.text(id + scr, 1552, p.y + 42, 20, t.dim, { align: 'right', literal: true });
            if (!rows.length) { cv.text('Nothing read yet', 48, 140, 26, t.dim); return; }
            rows.slice(detail * per, detail * per + per).forEach((r, i) => {
                const x = 48 + (i >= 10 ? 764 : 0), y = 118 + (i % 10) * 37;
                const has = r.value !== null, n = r.value;
                const val = has ? (Math.abs(n) >= 1000 ? thousands(n) : Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1)) + (r.unit ? ' ' + r.unit : '') : r.why;
                cv.text(LABELS[r.key] || r.key, x, y, 20, t.text);
                cv.text((r.ecu === D.SCR ? '0B ' : '') + r.did, x + 300, y, 18, t.dim, { literal: true });
                cv.text(val, x + 520, y, 20, has ? t.text : t.dim, { align: 'right', literal: has });
                cv.text(r.bytes, x + 536, y, 16, t.dim, { literal: true });
            });
            if (pages > 1) {
                G.button(cv, t, 1336, p.y + 12, 104, 40, 'Prev', () => { detail = (detail + pages - 1) % pages; return render(); }, { key: 'dprev' });
                G.button(cv, t, 1452, p.y + 12, 104, 40, 'Next', () => { detail = (detail + 1) % pages; return render(); }, { key: 'dnext' });
            }
        }

        function render() {
            const t = ctx.theme(), now = Date.now(), d = data();
            sample(d);
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (!d.demo && d.family === 'other') message(cv, t, 'Not a diesel engine unit', 'This car\'s engine unit (SGBD index ' + d.index + ') is not a diesel one (DDE).', 'The app reads B47 / B57 diesels only.');
            else if (!d.demo && page !== 4 && (d.status === 'NO LINK' || (!d.family && d.status !== 'IDENTIFYING'))) {
                message(cv, t, d.status === 'NO LINK' ? 'No diagnostic link' : d.status === 'PARKED' ? 'The car is parked and locked' : 'The engine unit doesn\'t answer',
                    d.status === 'NO LINK' ? 'The head unit\'s diagnostic service isn\'t there yet.' : 'Switch the ignition on or start the engine.');
            } else [renderDpf, renderRegens, renderAdblue, renderEngine, renderDetails][page](cv, t, d, now);
            const state = d.demo ? 'DEMO' : d.status;
            G.frame(cv, t, TABS, page, [
                d.phase === 'active' && page !== 0 && { text: 'REGENERATING', color: t.warn },
                d.diesel && !d.verified && !d.demo && { text: 'UNVERIFIED', color: t.warn },
                { text: state, color: state === 'LIVE' ? BLUE : t.warn },
            ]);
            return ui.image('MAIN_GFX', cv);
        }

        // every screen refresh (60 fps) with the GPU renderer; 4 fps in software
        ctx.loop('MAIN', 4, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
