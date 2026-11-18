'use strict';
/**
 * reader.js - reads the Diesel app's values (dde.js) from the engine unit (0x12) and the AdBlue unit (0x0B), over the
 * head unit's diagnostic link restricted to reading (kit/readonly-diag.js: nothing but 22 / 01 / 09 can leave).
 *
 *   const reader = new Reader({ signals, log, settings, canRead }).start();
 *   reader.want('ui', ['soot', 'dp', ...], 2000)     // what a source wants, and how often its live values (ms)
 *   reader.want('bg', [...], 20000)                  // (want(source, []) = nothing; the union is read)
 *   reader.value('soot') -> number or null           reader.raw('pid8b') -> the raw number (status words)
 *   reader.why('soot')   -> '' or why there's no value ('reading...', 'not on this car', 'no answer', ...)
 *   reader.status()      -> 'NO LINK' | 'PARKED' | 'NO ANSWER' | 'IDENTIFYING' | 'NOT A DIESEL' | 'LIVE' | 'STALE'
 *   reader.rows()        -> every value read so far, for the Details page
 *   reader.refresh()     -> ask everything again now (also what refused before)
 *
 * Pacing: one request at a time with GAP_MS between (on top of the link's own 25 ms), live values every fastMs, the
 * rest every SLOW_MS. Once an identifier's reply length is known, up to MAX_DIDS of them go in one request (62 <DID>
 * <data> <DID> <data> ..., taken apart with kit/sgbd.js split()). canRead() false (the car locked and left) = no
 * request at all, so the car can sleep; a unit that stops answering (ignition off) is asked again every WAKE_MS.
 *
 * A refusal (7F 22 nn) names no identifier, and every app on the head unit gets every reply, so one refusal may be
 * another app's: an identifier counts as "not on this car" only after ABSENT_AFTER refusals of its own single reads.
 */
const { ReadOnlyDiag, MAX_DIDS } = require('./kit/readonly-diag');
const { hex, NRC } = require('./kit/diag');
const { split } = require('./kit/sgbd');
const D = require('./dde');

const GAP_MS = 120, SLOW_MS = 30000, ASK_MS = 1500, WAKE_MS = 30000, STALE_MS = 15000, IDENT_MS = 3000, SCR_RETRY_MS = 300000;
const ABSENT = [0x11, 0x12, 0x31], ABSENT_AFTER = 3, ABSENT_RETRY_MS = 60000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Reader {
    /**
     * opts: { signals, log, settings, canRead: () => bool (default: always), engineType: () => 'diesel' | 'petrol' | null,
     * link (a ReadOnlyDiag to share; made here if none) }
     */
    constructor(opts) {
        this.log = opts.log;
        this.settings = opts.settings;
        this.canRead = opts.canRead || (() => true);
        this.engineType = opts.engineType || (() => null);
        this.link = opts.link || new ReadOnlyDiag(opts.signals, opts.log);
        this.ownLink = !opts.link;
        this.wants = {};               // source -> { keys, fastMs }
        this.vals = {};                // key -> { v, raw, at, why }
        this.dids = {};                // 'ecu:DID' -> { ecu, did, len, single, asked, absentN, absentUntil, bytes, why, at }
        this.family = null;            // dde.js family: d83 / d7x / d94 / unknown, or 'other' (not a diesel)
        this.index = null;             // the engine unit's SGBD index
        this.scr = undefined;          // the AdBlue unit's family (scr04 / scr03), null = none / unknown, undefined = not asked
        this.scrIndex = null; this.scrAsked = 0;
        this.replied = false; this.lastGood = 0; this.wokenT = 0; this.identT = 0;
        this.running = false; this.busyKey = null;
        this.logged = {};
    }

    start() {
        if (this.running) return this;
        this.running = true;
        if (this.ownLink) this.link.init().catch((e) => this.log.warn('diagnostic link: ' + (e && e.message || e)));
        this.pump().catch((e) => this.log.error('diesel reader: ' + (e && e.stack || e)));
        return this;
    }
    stop() { this.running = false; this.link.cancel(); }

    /** What a source wants read: keys (dde.js VALUES) and how often the live ones (ms). */
    want(source, keys, fastMs) {
        this.wants[source] = { keys: (keys || []).filter((k) => !!D.VALUES[k]), fastMs: fastMs || 2000 };
    }
    wanted() {
        const out = {};
        Object.keys(this.wants).forEach((s) => this.wants[s].keys.forEach((k) => {
            const ms = D.VALUES[k].live ? this.wants[s].fastMs : Math.max(SLOW_MS, this.wants[s].fastMs);
            out[k] = out[k] ? Math.min(out[k], ms) : ms;
        }));
        return out;
    }

    /** Ask everything again now: values, refusals, a unit that went quiet. */
    refresh() {
        Object.keys(this.dids).forEach((k) => { const r = this.dids[k]; r.asked = 0; r.absentN = 0; r.absentUntil = 0; });
        this.scrAsked = 0;
        if (this.family === null || this.family === 'other') this.identT = 0;
        this.link.wake();
    }

    get diesel() { return !!this.family && this.family !== 'other'; }
    get verified() { return D.verified(this.family); }

    value(key) { const r = this.vals[key]; return r && r.v !== null && r.v !== undefined ? r.v : null; }
    raw(key) { const r = this.vals[key]; return r && r.raw !== undefined ? r.raw : null; }
    age(key) { const r = this.vals[key]; return r && r.at ? Date.now() - r.at : null; }

    /** Why a key has no value ('' when it has one). */
    why(key) {
        if (this.value(key) !== null) return '';
        if (!this.link.ready) return 'no diagnostic link';
        if (!this.canRead()) return 'car parked';
        const spec = this.specOf(key);
        if (this.family === 'other') return 'not a diesel engine unit';
        if (this.family && !spec) return 'not on this car';
        if (D.ON_SCR[key] && this.scr === null) return 'no AdBlue unit';
        const r = spec && this.dids[this.didKey(key, spec)];
        if (r && r.absentN >= ABSENT_AFTER) return 'not on this car';
        if (r && r.why) return r.why;
        const v = this.vals[key];
        if (v && v.why) return v.why;
        return 'reading...';
    }

    status() {
        if (!this.link.ready) return 'NO LINK';
        if (!this.canRead()) return 'PARKED';
        if (this.link.silent(D.DDE)) return 'NO ANSWER';
        if (!this.family) return 'IDENTIFYING';
        if (this.family === 'other') return 'NOT A DIESEL';
        return Date.now() - this.lastGood > STALE_MS ? 'STALE' : 'LIVE';
    }

    /** Every identifier asked so far, for the Details page: { key, ecu, did, value, unit, why, bytes, at }. */
    rows() {
        return Object.keys(D.VALUES).filter((k) => this.vals[k] || this.dids[this.didKey(k, this.specOf(k) || {})]).map((k) => {
            const spec = this.specOf(k) || {}, r = this.dids[this.didKey(k, spec)] || {}, v = this.vals[k] || {};
            return { key: k, ecu: D.ON_SCR[k] ? D.SCR : D.DDE, did: spec.did || '', value: this.value(k), raw: this.raw(k), unit: D.VALUES[k].unit,
                why: this.why(k), bytes: r.bytes || '', at: v.at || 0 };
        });
    }

    specOf(key) {
        if (D.ON_SCR[key]) return this.scr ? D.specOf(key, this.scr) : null;
        return this.family && this.family !== 'other' ? D.specOf(key, this.family) : null;
    }
    didKey(key, spec) { return (D.ON_SCR[key] ? D.SCR : D.DDE) + ':' + (spec && spec.did); }

    once(key, msg) { if (!this.logged[key]) { this.logged[key] = true; this.log.info(msg); } }

    /* ---------- identification ---------- */

    /** The unit's SGBD index (22 F1 50), positive replies only (a refusal may be another app's): '0F2670', or null. */
    async index0(ecu) {
        let u = null;
        try { u = await this.link.physical(ecu, 0x22, [0xF1, 0x50], ASK_MS, (x) => x[0] === 0x62 && x[1] === 0xF1 && x[2] === 0x50); } catch (e) { return null; }
        if (!u || u.length < 6) return null;
        return [u[3], u[4], u[5]].map((b) => hex(b)).join('');
    }

    async identify() {
        this.identT = Date.now();
        const index = await this.index0(D.DDE);
        if (!index) return;
        this.replied = true;
        this.index = index;
        let fam = D.familyOf(index);
        if (!fam) {
            // not a DDE we know: a diesel by the car's engine type, or one that answers like a DDE (soot and the
            // distance since the last regeneration both plausible); else not a diesel
            const type = this.engineType();
            if (type === 'diesel') fam = 'unknown';
            else if (type === 'petrol') fam = 'other';
            else {
                const a = await this.probe(D.specOf('soot', 'd83')), b = await this.probe(D.specOf('sinceKm', 'd83'));
                fam = a !== null && b !== null ? 'unknown' : 'other';
            }
        }
        this.family = fam;
        this.log.info('engine unit: SGBD index ' + index + ' -> ' + (fam === 'other' ? 'not a diesel engine unit, nothing read' : D.NAMES[fam] + (D.verified(fam) ? '' : ' (read as DDE 8.3, unverified)')));
    }

    async probe(spec) {
        let u = null;
        try { u = await this.link.read(D.DDE, parseInt(spec.did, 16), ASK_MS); } catch (e) { return null; }
        if (!u || u[0] !== 0x62) return null;
        return D.decode(spec, Array.prototype.slice.call(u, 3));
    }

    async identifyScr() {
        this.scrAsked = Date.now();
        const index = await this.index0(D.SCR);
        this.scrIndex = index;
        this.scr = index ? D.scrFamilyOf(index) : null;
        this.once('scr' + index, index ? 'AdBlue unit: SGBD index ' + index + (this.scr ? ' -> ' + this.scr.toUpperCase() : ' (no known layout, its tank level not read)') : 'AdBlue unit: no answer at 0x0B');
    }

    /* ---------- reading ---------- */

    /** The identifiers due now: [{ ecu, did, keys, len }], by how long they're overdue. */
    due(now) {
        const want = this.wanted(), by = {};
        Object.keys(want).forEach((key) => {
            const spec = this.specOf(key);
            if (!spec) return;
            const k = this.didKey(key, spec);
            const r = this.dids[k] || (this.dids[k] = { ecu: D.ON_SCR[key] ? D.SCR : D.DDE, did: spec.did, len: null, single: true, asked: 0, absentN: 0, absentUntil: 0, bytes: '', why: '' });
            if (r.absentUntil > now || this.link.silent(r.ecu)) return;
            const late = now - r.asked - want[key];
            if (late < 0) return;
            const e = by[k] || (by[k] = { k, r, keys: [], late });
            e.keys.push(key);
            e.late = Math.max(e.late, late);
        });
        return Object.keys(by).map((k) => by[k]).sort((a, b) => b.late - a.late);
    }

    /** One request: the most overdue identifier, with others of the same unit whose length is known (up to MAX_DIDS). */
    async step(now) {
        const due = this.due(now);
        if (!due.length) return false;
        const first = due[0], ecu = first.r.ecu;
        const batch = [first];
        if (!first.r.single && first.r.len !== null) {
            for (let i = 1; i < due.length && batch.length < MAX_DIDS; i++) {
                const e = due[i];
                if (e.r.ecu === ecu && !e.r.single && e.r.len !== null) batch.push(e);
            }
        }
        batch.forEach((e) => { e.r.asked = now; });
        const ids = batch.map((e) => parseInt(e.r.did, 16));
        let u;
        try { u = await this.link.readMany(ecu, ids, ASK_MS); } catch (e) {
            batch.forEach((b) => { b.r.why = String(e && e.message || e).indexOf('transport refused') >= 0 ? 'link busy' : 'no diagnostic link'; });
            return true;
        }
        if (u === undefined) { batch.forEach((b) => { b.r.asked = 0; }); return true; }     // cancelled before it went
        if (!u) { batch.forEach((b) => { b.r.why = 'no answer'; }); return true; }
        this.replied = true;
        if (u[0] === 0x7F) {
            if (batch.length > 1) { batch.forEach((b) => { b.r.single = true; b.r.asked = 0; }); return true; }   // ask them one by one
            this.refused(first.r, u[2], now);
            return true;
        }
        if (batch.length === 1) {
            const data = Array.prototype.slice.call(u, 3);
            this.got(first, data, now);
            if (first.r.len === null) first.r.len = data.length;
            else if (first.r.len !== data.length) { first.r.len = data.length; }
            first.r.single = false;
            return true;
        }
        const lens = {};
        batch.forEach((b) => { lens[parseInt(b.r.did, 16)] = b.r.len; });
        const parts = split(Array.prototype.slice.call(u), lens);
        if (!parts) { batch.forEach((b) => { b.r.single = true; b.r.asked = 0; }); this.once('split' + first.r.did, 'reply to ' + batch.map((b) => b.r.did).join(' ') + ' did not add up: read one by one'); return true; }
        batch.forEach((b) => {
            const p = parts[parseInt(b.r.did, 16)];
            if (p) this.got(b, p.slice(3), now);
            else { b.r.single = true; b.r.asked = 0; }          // left out of the reply: its own request tells why
        });
        return true;
    }

    got(e, data, now) {
        const r = e.r;
        r.absentN = 0; r.absentUntil = 0; r.why = '';
        r.bytes = data.map((b) => hex(b)).join(' ');
        r.at = now;
        this.lastGood = now;
        this.once('ok' + r.ecu + r.did, 'unit ' + hex(r.ecu) + ' ' + r.did + ': ' + r.bytes);
        e.keys.forEach((key) => {
            const spec = this.specOf(key), v = D.decode(spec, data);
            this.vals[key] = { v, raw: D.rawOf(spec, data), at: now, why: v === null ? (data.length < (spec.at || 0) + (spec.bytes || 1) ? 'reply too short' : 'out of range') : '' };
        });
    }

    refused(r, nrc, now) {
        r.why = 'refused (NRC ' + hex(nrc) + (NRC[nrc] ? ' ' + NRC[nrc] : '') + ')';
        if (ABSENT.indexOf(nrc) >= 0) {
            r.absentN++;
            r.absentUntil = now + ABSENT_RETRY_MS * Math.min(r.absentN, 10);
            if (r.absentN === ABSENT_AFTER) this.log.info('unit ' + hex(r.ecu) + ' ' + r.did + ': not on this car (' + r.why + ')');
        } else if (nrc === 0x22) r.why = 'refused now (conditions)';
    }

    async pump() {
        while (this.running) {
            const now = Date.now();
            if (!this.link.ready || !this.canRead() || !Object.keys(this.wanted()).length || (this.settings && this.settings.get('demo') === 'on')) { await sleep(300); continue; }
            if (this.link.silent(D.DDE)) {
                if (now - this.wokenT < WAKE_MS) { await sleep(500); continue; }
                this.wokenT = now; this.link.wake(D.DDE);
            }
            if (!this.family) {
                if (now - this.identT < IDENT_MS) { await sleep(300); continue; }
                await this.identify();
                await sleep(GAP_MS);
                continue;
            }
            if (this.family === 'other') { await sleep(1000); continue; }
            if (this.scr === undefined || (this.scr === null && now - this.scrAsked > SCR_RETRY_MS)) {
                const w = this.wanted();
                if (Object.keys(w).some((k) => D.ON_SCR[k])) { await this.identifyScr(); await sleep(GAP_MS); continue; }
            }
            const did = await this.step(now);
            await sleep(did ? GAP_MS : 200);
        }
    }
}

Reader.GAP_MS = GAP_MS; Reader.SLOW_MS = SLOW_MS; Reader.ABSENT_AFTER = ABSENT_AFTER; Reader.STALE_MS = STALE_MS;
module.exports = { Reader };
