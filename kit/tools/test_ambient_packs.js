'use strict';
// Ambient config's light packs (apps/ambient_config/packs.js) and their runner (Strobe.runPack in strobe.js) against a
// fake body controller: the delays ("1.5s", "1500ms", 500), a pack checked step by step, your own packs read from a
// folder, the exact requests (the extended session first, the light functions, 3E 00 while a step waits, the session
// entered again when the unit dropped it), and the lamps handed back however a pack ends: done, stopped, refused,
// looped to its limit. Also the gate (nothing sent while the car moves), the rest after a run and Clear light faults.
//   node kit/tools/test_ambient_packs.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = path.join(__dirname, '..', '..', 'apps', 'ambient_config');
const { Strobe, PACK_MAX_MS, gateChecks, gateWhy } = require(path.join(APP, 'strobe'));
const P = require(path.join(APP, 'packs'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const hex = (b) => b.map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');
const log = { info() {}, warn() {} };

/**
 * car: 'fn' (BDC with LEUCHTEN_FUNKTION), 'bdc' / 'g05' (lamp outputs only), 'none'.
 * o: dropAfter (the session is lost after this many writes: 7F 2E 7F, once), refuseAfter (NRC 22 after this many
 * writes), heads (headlight units at 0x43 / 0x44 answer the fault clear)
 */
function fakeCar(car, o, clock) {
    const opt = o || {};
    const sent = [], out = {};
    let session = 1, writes = 0, dropped = false;
    return {
        sent, out, get session() { return session; },
        async physical(target, sid, data) {
            sent.push(hex([target, sid].concat(data)));
            clock.t += 200; await new Promise((r) => setImmediate(r));
            if (sid === 0x14) return target === 0x40 || (opt.heads && (target === 0x43 || target === 0x44)) ? [0x54] : null;
            if (target !== 0x40 || car === 'none') return null;
            if (sid === 0x10) { session = data[0]; return [0x50, data[0], 0, 0x32, 0x01, 0xF4]; }
            if (sid === 0x3E) return [0x7E, 0x00];
            if (sid === 0x22) {
                if (car === 'fn' && data[0] === 0xD5 && data[1] === 0x42) return [0x62, 0xD5, 0x42].concat(new Array(20).fill(0));
                if (car === 'bdc' && data[0] === 0x45 && data[1] === 0x00) return [0x62, 0x45, 0x00].concat(new Array(31).fill(0));
                if (car === 'g05' && data[0] === 0xE3 && data[1] === 0xB9) return [0x62, 0xE3, 0xB9].concat(new Array(31).fill(0));
                return [0x7F, 0x22, 0x31];
            }
            const write = sid === 0x2E || sid === 0x2F;
            if (write && session !== 0x03) return [0x7F, sid, 0x7F];
            if (write && (data[0] !== 0x45 || data[1] !== 0x30) && !(sid === 0x2F && data[2] === 0x00) && !(sid === 0x2E && data[4] === 0 && data[5] === 0)) {
                writes++;
                if (opt.dropAfter != null && writes > opt.dropAfter && !dropped) { dropped = true; session = 1; return [0x7F, sid, 0x7F]; }
                if (opt.refuseAfter != null && writes > opt.refuseAfter) return [0x7F, sid, 0x22];
            }
            if (sid === 0x2E && data[0] === 0xD5 && data[1] === 0x42) return car === 'fn' ? [0x6E, 0xD5, 0x42] : [0x7F, 0x2E, 0x31];
            if (sid === 0x2E && data[0] === 0x45 && data[1] === 0x30) return [0x6E, 0x45, 0x30];
            if (sid === 0x2F) {
                const did = car === 'g05' ? [0xE3, 0xB5] : [0x45, 0x01];
                if (car === 'fn' || data[0] !== did[0] || data[1] !== did[1]) return [0x7F, 0x2F, 0x31];
                if (data[2] === 0x03) out[data[3]] = data[4]; else if (data[2] === 0x00) delete out[data[3]];
                return [0x6F].concat(data.slice(0, 3));
            }
            return [0x7F, sid, 0x11];
        },
    };
}
function make(car, o) {
    const clock = { t: 1000000 };
    const diag = fakeCar(car, o, clock);
    const ev = [];
    const s = new Strobe({ diag, log, allowed: (o && o.allowed) || (() => null), now: () => clock.t,
        hold: async (on) => { ev.push(on ? 'hold' : 'go'); },
        sleep: (ms) => new Promise((r) => { clock.t += Math.max(ms, 1); setImmediate(r); }) });
    return { s, diag, clock, ev };
}
const pack = (raw) => { const v = P.validate(raw); if (!v.ok) throw new Error(v.errors.join('; ')); return v.pack; };
const builtIn = (id) => P.BUILT_IN.find((p) => p.id === id);
const fnOn = (f, ms) => '40 2E D5 42 00 ' + hex([f]) + ' ' + hex([(ms / 10) >> 8, (ms / 10) & 0xFF]);
const fnOff = (f) => '40 2E D5 42 00 ' + hex([f]) + ' 00 00';
/** stop() once the car has had n requests */
const stopAfter = (s, diag, n) => { const tick = () => (diag.sent.length >= n ? s.stop() : setImmediate(tick)); setImmediate(tick); };

(async () => {
    // delays as BimmerLight's editor takes them
    ok(P.parseDelay('1.5s') === 1500 && P.parseDelay('1500ms') === 1500 && P.parseDelay('500') === 500 && P.parseDelay(500) === 500
        && P.parseDelay(' 2 S ') === 2000 && P.parseDelay(undefined) === 0, 'delays: 1.5s, 1500ms, 500');
    ok(P.parseDelay('fast') === null && P.parseDelay('-1') === null && P.parseDelay('11s') === null && P.parseDelay('1.5 min') === null, 'not delays');

    // a pack checked step by step
    {
        const v = P.validate({ id: 'x', title: 'X', steps: [{ fn: 'laser' }, { fn: 'high', delay: 'soon' }, { output: 'FL_L' }, { fn: 'high', ms: 5000 }, { wait: 0 }, { fn: 'high', repeat: 50 }] });
        ok(!v.ok && v.errors.length === 6 && /laser/.test(v.errors[0]) && /delay "soon"/.test(v.errors[1]) && /"on"/.test(v.errors[2])
            && /ms must be/.test(v.errors[3]) && /wait/.test(v.errors[4]) && /repeat/.test(v.errors[5]), 'each wrong step named (' + v.errors.join(' | ') + ')');
        ok(!P.validate({ id: 'bad id!', title: 'X', steps: [{ fn: 'high' }] }).ok && !P.validate({ id: 'x', steps: [{ fn: 'high' }] }).ok
            && !P.validate({ id: 'x', title: 'X', steps: [] }).ok && !P.validate({ id: 'x', title: 'X', steps: [{ wait: 500 }] }).ok, 'id, title, steps');
        const p = pack({ id: 's', title: 'S', steps: [{ seq: [{ fn: 'indL' }, { fn: 'indR', delay: '0.5s' }], repeat: 3 }, { disco: 2000 }, { wait: '1s' }] });
        ok(p.steps.length === 8 && p.steps[1].delayMs === 500 && p.steps[6].job === 'disco' && p.steps[6].delayMs === 2000 && p.steps[7].delayMs === 1000,
            'seq repeated, a disco and a wait wait for themselves');
        ok(p.needs.join() === 'fn,disco' && p.ms === 3 * (200 + 500) + 2000 + 1000, 'what it needs and how long it takes (' + p.ms + ' ms)');
        ok(P.BUILT_IN.length >= 10 && P.BUILT_IN.every((b) => b.builtIn && b.steps.length && b.ms > 0 && b.ms <= PACK_MAX_MS), 'the built-in packs are all right and shorter than a press');
    }

    // your own packs from a folder
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-packs-'));
        try {
            fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'wave', title: 'Wave', steps: [{ fn: ['parkL', 'parkR'], ms: 300, delay: '400ms', repeat: 2 }] }));
            fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify([{ id: 'one', title: 'One', steps: [{ fn: 'high' }] }, { id: 'one', title: 'Again', steps: [{ fn: 'high' }] },
                { id: 'broken', title: 'Broken', steps: [{ fn: 'nope' }] }]));
            fs.writeFileSync(path.join(dir, 'c.json'), '{ not json');
            fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
            const l = P.load(dir, log);
            ok(l.map((p) => p.id).join() === 'my:wave,my:one,my:broken,my:c.json', 'every .json, ids kept apart, the same id once (' + l.map((p) => p.id).join() + ')');
            ok(!l[0].errors && l[0].steps.length === 2 && l[2].errors && /nope/.test(l[2].errors[0]) && /not JSON/.test(l[3].errors[0]), 'a wrong one listed with what is wrong');
            ok(P.load(path.join(dir, 'none'), log).length === 0, 'no folder: no packs of your own');
        } finally { fs.readdirSync(dir).forEach((f) => fs.unlinkSync(path.join(dir, f))); fs.rmdirSync(dir); }
    }

    // a pack on the body controller's light functions: exactly these requests
    {
        const { s, diag, ev } = make('fn');
        await s.find(); diag.sent.length = 0;
        await s.runPack(builtIn('double'));
        const want = ['40 10 03', fnOn(0x05, 120), fnOn(0x05, 120), fnOff(0x05), '40 10 01'];
        ok(diag.sent.filter((x) => !/ 3E /.test(x)).join() === want.join(), 'double flash: session, two flashes, off, default session (' + diag.sent.join(', ') + ')');
        ok(ev.join() === 'hold,go' && s.running === null && /Double flash done/.test(s.note), 'the ambient lights held and let go, done (' + s.note + ')');
        ok(/rest/.test(s.packWhy(builtIn('once')) || s._resting() || ''), 'then the lights rest');
    }
    // several functions in a step, one after the other; every one used is switched off at the end
    {
        const { s, diag } = make('fn');
        await s.find(); diag.sent.length = 0;
        await s.runPack(builtIn('headlight'));
        const w = diag.sent.filter((x) => /2E D5 42/.test(x));
        ok(w.length === 16 + 2 && w[0] === fnOn(0x05, 100) && w[1] === fnOn(0x08, 100) && w.slice(-2).sort().join() === [fnOff(0x05), fnOff(0x08)].sort().join(),
            'high beam and fog together, eight times, both off at the end');
    }
    // a long wait: the session kept with 3E 00, not entered again
    {
        const { s, diag } = make('fn');
        await s.find(); diag.sent.length = 0;
        await s.runPack(pack({ id: 'w', title: 'Wait', steps: [{ fn: 'high', ms: 100 }, { wait: '9s' }, { fn: 'high', ms: 100 }] }));
        const keeps = diag.sent.filter((x) => x === '40 3E 00').length;
        ok(keeps >= 3 && diag.sent.filter((x) => x === '40 10 03').length === 1, 'kept with 3E 00 (' + keeps + ' times), one session');
    }
    // the unit drops the session: entered again and the write asked once more
    {
        const { s, diag } = make('fn', { dropAfter: 2 });
        await s.find(); diag.sent.length = 0;
        await s.runPack(builtIn('triple'));
        const fl = diag.sent.filter((x) => x === fnOn(0x05, 100)).length;
        ok(diag.sent.filter((x) => x === '40 10 03').length === 2 && fl === 4 && /done/.test(s.note), 'session again, the third flash asked again (' + diag.sent.join(', ') + ')');
    }
    // refused: stops, the lamps handed back all the same
    {
        const { s, diag } = make('fn', { refuseAfter: 3 });
        await s.find(); diag.sent.length = 0;
        await s.runPack(builtIn('racing'));
        ok(/refused \(NRC 22\)/.test(s.note) && diag.sent.slice(-3).join() === [fnOff(0x06), fnOff(0x07), '40 10 01'].join(), 'refused: stopped, indicators off, default session (' + s.note + ')');
    }
    // Stop mid-pack
    {
        const { s, diag } = make('fn');
        await s.find(); diag.sent.length = 0;
        const run = s.runPack(builtIn('all'));
        stopAfter(s, diag, 6);
        await run;
        ok(/Every light stopped/.test(s.note) && diag.sent[diag.sent.length - 1] === '40 10 01' && diag.sent.filter((x) => /2E D5 42/.test(x)).length < 24 + 12,
            'stopped: handed back (' + s.note + ')');
    }
    // loop: round and round until the press's limit
    {
        const { s, diag } = make('fn');
        await s.find(); diag.sent.length = 0;
        await s.runPack(builtIn('once'), { loop: true });
        const flashes = diag.sent.filter((x) => x === fnOn(0x05, 150)).length;
        ok(/done \(60 s\)/.test(s.note) && flashes > 100, 'looped until 60 s (' + flashes + ' flashes, ' + s.note + ')');
    }
    // the lamp outputs (cars without light functions): every output switched is handed back
    for (const [car, did] of [['bdc', '45 01'], ['g05', 'E3 B5']]) {
        const { s, diag } = make(car);
        await s.find(); diag.sent.length = 0;
        ok(/light functions/.test(s.packWhy(builtIn('double'))), car + ': a light-function pack is not for this car');
        await s.runPack(builtIn('outputs'));
        ok(diag.sent[1] === '40 2F ' + did + ' 03 07 01' && diag.sent.slice(-5).join() === ['40 2F ' + did + ' 03 07 00', '40 2F ' + did + ' 00 07 00',
            '40 2F ' + did + ' 03 08 00', '40 2F ' + did + ' 00 08 00', '40 10 01'].join() && !Object.keys(diag.out).length, car + ': outputs switched and handed back');
    }
    // the body controller's own show: stopped early, a zero-length one ends it
    {
        const { s, diag } = make('g05');
        await s.find(); diag.sent.length = 0;
        const run = s.runPack(builtIn('disco'));
        stopAfter(s, diag, 4);
        await run;
        ok(diag.sent[1] === '40 2E 45 30 64 00 04 00 1F 40 00 00' && diag.sent.slice(-2).join() === '40 2E 45 30 00 00 04 00 00 00 00 00,40 10 01', 'show for 8 s, ended when stopped');
    }
    // the gate: nothing at all sent while the car moves
    {
        const checksNow = gateChecks({ setting: true, away: false, moving: true });
        ok(gateWhy(checksNow, 'pack') === 'the car standing still (light show, packs): no' && gateWhy(checksNow, 'strobe') === null, 'packs only standing still');
        const { s, diag } = make('fn', { allowed: (what) => gateWhy(gateChecks({ setting: true, away: false, moving: true }), what) });
        await s.find(); diag.sent.length = 0;
        await s.runPack(builtIn('once'));
        ok(!diag.sent.length && /not started: the car standing still/.test(s.note), 'moving: not started, nothing sent');
        // and the car moving off mid-pack stops it
        let moving = false;
        const m = make('fn', { allowed: (what) => gateWhy(gateChecks({ setting: true, away: false, moving }), what) });
        await m.s.find(); m.diag.sent.length = 0;
        const run = m.s.runPack(builtIn('ghost'));
        const tick = () => (m.diag.sent.length >= 4 ? (moving = true) : setImmediate(tick)); setImmediate(tick);
        await run;
        ok(/stopped: the car standing still/.test(m.s.note) && m.diag.sent[m.diag.sent.length - 1] === '40 10 01', 'moving off: stopped and handed back');
    }
    // a pack that is not right does not run
    {
        const { s, diag } = make('fn');
        await s.find(); diag.sent.length = 0;
        await s.runPack({ id: 'my:x', title: 'X', errors: ['steps[0]: no light function nope'], steps: [], needs: [] });
        ok(!diag.sent.length && /has errors/.test(s.note), 'a pack with errors: nothing sent');
        const n = make('none');
        await n.s.find();
        ok(/no headlight/.test(n.s.packWhy(builtIn('once'))), 'no lamp control: no pack');
    }
    // Clear light faults: the body controller and the headlight units that answer
    {
        const a = make('fn', { heads: true });
        const r = await a.s.clearFaults();
        ok(a.diag.sent.join() === '40 14 FF FF FF,43 14 FF FF FF,44 14 FF FF FF' && r.length === 3 && r.every((x) => x.ok) && a.ev.join() === 'hold,go', 'three units cleared');
        const b = make('fn');
        const r2 = await b.s.clearFaults();
        ok(r2.length === 1 && r2[0].ecu === 0x40 && /1 of 1/.test(b.s.note), 'headlight units that do not answer left out (' + b.s.note + ')');
    }
    console.log('ambient packs: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
