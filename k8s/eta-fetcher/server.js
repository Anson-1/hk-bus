/**
 * HK Transit ETA Fetcher Service
 * Collects real-time ETA data from KMB, CTB, GMB, MTR APIs
 * and stores directly into PostgreSQL (4 schemas: kmb, ctb, gmb, mtr)
 *
 * Poll intervals:
 *   KMB / CTB / MTR : every 30 seconds
 *   GMB             : every 60 seconds (larger route set, slower API)
 */

'use strict';

const express = require('express');
const axios   = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

// ── Express health check ──────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3002;

// ── API base URLs ─────────────────────────────────────────────
const KMB_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';
const CTB_BASE = 'https://rt.data.gov.hk/v2/transport/citybus';
const GMB_BASE = 'https://data.etagmb.gov.hk';
const MTR_BASE = 'https://rt.data.gov.hk/v1/transport/mtr';

// ── Poll intervals ────────────────────────────────────────────
const KMB_INTERVAL = 60_000;   // 60s — KMB has 796 routes, each cycle takes ~2-3 min
const CTB_INTERVAL = 60_000;   // 60s
const GMB_INTERVAL = 120_000;  // 2 min — 775 routes with 3-step chain
const MTR_INTERVAL = 30_000;   // 30s — static stations, fast

// ── Concurrency limits (routes processed in parallel per batch) ─
const KMB_CONCURRENCY =  1;   // fully sequential — KMB rate limits aggressively
const CTB_CONCURRENCY =  2;
const GMB_CONCURRENCY =  2;
const MTR_CONCURRENCY =  5;

// ── PostgreSQL pool ───────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || 'postgres',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'hkbus',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 10,
});
db.on('error', err => console.warn('[DB] pool error:', err.message));

// ── In-memory stop detail cache (avoids re-fetching every cycle) ─
const kmbStopCache = new Map(); // stopId → true (already upserted)
const ctbStopCache = new Map();

// ── Route lists (loaded on startup, refreshed hourly) ─────────
let kmbRoutes = [];   // ['1','2','5C', ...]
let ctbRoutes = [];   // ['1','5B','10', ...]
let gmbRoutes = [];   // [{region, route_code, route_id, directions:[]}]
// MTR is static — defined inline below

// ── Stats ─────────────────────────────────────────────────────
const stats = {
  kmb: { fetched: 0, inserted: 0, errors: 0, lastCycle: null },
  ctb: { fetched: 0, inserted: 0, errors: 0, lastCycle: null },
  gmb: { fetched: 0, inserted: 0, errors: 0, lastCycle: null },
  mtr: { fetched: 0, inserted: 0, errors: 0, lastCycle: null },
};

// ── Static MTR lines and stations ────────────────────────────
const MTR_LINES = {
  AEL: ['HOK','KOW','TSY','AIR','AWE'],
  TCL: ['HOK','KOW','OLY','NAC','LAK','TSY','SUN','TUC'],
  TML: ['WKS','MOS','HEO','TSH','SHM','CIO','STW','CKT','TAW','HIK','DIH','KAT','SUW','TKW','HOM','HUH','ETS','AUS','NAC','TWW','MEF','TWH','LOP','YUL','KSR','TIS'],
  TKL: ['NOP','QUB','YAT','TIK','TKO','HAH','POA','LHP'],
  EAL: ['ADM','TAW','MKK','KOT','SHT','FOT','UNI','TAP','TWO','FAN','SHS','LOW','LMC'],
  SIL: ['ADM','OCP','WCH','LET','SKW','SGW'],
  TWL: ['CEN','ADM','TSW','PAA','MEF','LAK','KWH','KWF','KWT','LEK','PRE','CSW','SSP','MOK','YMT','JOR','TST'],
  ISL: ['KEN','HFC','SHW','SYP','HKU','ADM','CEN','WAC','CAB','TIH','FOH','NOP','QUB','TAK','SWH','SKW'],
  KTL: ['PRE','SKM','KOT','LOF','WTS','DIH','CHH','KOB','NTK','KWT','LAT','YAT','TIK'],
  DRL: ['OLY','TSY','SUN','DIS'],
};

// ── Helpers ───────────────────────────────────────────────────

/** Safe HTTP GET — returns {} on any error */
const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; HKTransitCollector/1.0)',
  'Accept': 'application/json',
};

async function get(url, params = {}, timeout = 10000) {
  try {
    const res = await axios.get(url, { params, timeout, headers: HTTP_HEADERS });
    return res.data || {};
  } catch (e) {
    // On 403, wait 10s to let the rate limit window reset
    if (e.response?.status === 403) {
      console.warn(`[HTTP] 403 rate limited — waiting 10s`);
      await sleep(10000);
    } else {
      console.warn(`[HTTP] FAIL ${url} — ${e.message}`);
    }
    return {};
  }
}

/** Run an array of async tasks with max N in parallel */
async function withConcurrency(items, concurrency, fn) {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.allSettled(items.slice(i, i + concurrency).map(fn));
  }
}

/** Sleep for ms milliseconds */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Convert any date/ISO string to a naive HKT string for PostgreSQL TIMESTAMP.
 * e.g. "2026-05-02T14:45:00+08:00" → "2026-05-02 14:45:00"
 */
function toHKT(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  // Add 8h offset to get HKT, then format without timezone
  const hkt = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  return hkt.toISOString().replace('T', ' ').substring(0, 23);
}

/** Current time as naive HKT string */
function nowHKT() {
  return toHKT(new Date());
}

/** Extract hour (0-23) and day-of-week (0=Mon..6=Sun) from a HKT string */
function timeComponents(hktStr) {
  if (!hktStr) {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    return { hour: now.getUTCHours(), dow: (now.getUTCDay() + 6) % 7 };
  }
  const d = new Date(hktStr.replace(' ', 'T') + 'Z'); // treat as UTC to read components
  return { hour: d.getUTCHours(), dow: (d.getUTCDay() + 6) % 7 };
}

// ── Route loaders ─────────────────────────────────────────────

async function loadKMBRoutes() {
  const data = await get(`${KMB_BASE}/route`, {}, 30000);
  const rows = (data.data && Array.isArray(data.data)) ? data.data : null;

  if (rows) {
    kmbRoutes = [...new Set(rows.map(r => r.route))];
    console.log(`[KMB] Loaded ${kmbRoutes.length} routes`);
    for (const r of rows) {
      try {
        await db.query(`
          INSERT INTO kmb.routes (route, bound, orig_en, dest_en, orig_tc, dest_tc)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (route, bound) DO NOTHING
        `, [r.route, r.bound, r.orig_en||null, r.dest_en||null, r.orig_tc||null, r.dest_tc||null]);
      } catch {}
    }
    console.log(`[KMB] Routes upserted into kmb.routes`);
  } else {
    await sleep(5000);
    const retry = await get(`${KMB_BASE}/route`, {}, 30000);
    if (retry.data && Array.isArray(retry.data)) {
      kmbRoutes = [...new Set(retry.data.map(r => r.route))];
      console.log(`[KMB] Loaded ${kmbRoutes.length} routes (retry)`);
      for (const r of retry.data) {
        try {
          await db.query(`
            INSERT INTO kmb.routes (route, bound, orig_en, dest_en, orig_tc, dest_tc)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (route, bound) DO NOTHING
          `, [r.route, r.bound, r.orig_en||null, r.dest_en||null, r.orig_tc||null, r.dest_tc||null]);
        } catch {}
      }
      console.log(`[KMB] Routes upserted into kmb.routes (retry)`);
    } else if (kmbRoutes.length === 0) {
      kmbRoutes = ['1', '2', '5C'];
      console.warn('[KMB] API unavailable, using fallback routes');
    }
  }
}

async function loadCTBRoutes() {
  const data = await get(`${CTB_BASE}/route/CTB`, {}, 30000);
  const rows = (data.data && Array.isArray(data.data)) ? data.data : null;

  if (rows) {
    ctbRoutes = [...new Set(rows.map(r => r.route))];
    console.log(`[CTB] Loaded ${ctbRoutes.length} routes`);
    console.log(`[CTB] Sample route object:`, JSON.stringify(rows[0]));
    for (const r of rows) {
      const bound = r.bound === 'inbound' ? 'I' : r.bound === 'outbound' ? 'O' : r.bound;
      if (!bound) continue;
      try {
        await db.query(`
          INSERT INTO ctb.routes (route, bound, orig_en, dest_en, orig_tc, dest_tc)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (route, bound) DO NOTHING
        `, [r.route, bound, r.orig_en||null, r.dest_en||null, r.orig_tc||null, r.dest_tc||null]);
      } catch {}
    }
    console.log(`[CTB] Routes upserted into ctb.routes`);
  } else {
    await sleep(5000);
    const retry = await get(`${CTB_BASE}/route/CTB`, {}, 30000);
    if (retry.data && Array.isArray(retry.data)) {
      ctbRoutes = [...new Set(retry.data.map(r => r.route))];
      console.log(`[CTB] Loaded ${ctbRoutes.length} routes (retry)`);
      for (const r of retry.data) {
        const bound = r.bound === 'inbound' ? 'I' : r.bound === 'outbound' ? 'O' : r.bound;
        if (!bound) continue;
        try {
          await db.query(`
            INSERT INTO ctb.routes (route, bound, orig_en, dest_en, orig_tc, dest_tc)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (route, bound) DO NOTHING
          `, [r.route, bound, r.orig_en||null, r.dest_en||null, r.orig_tc||null, r.dest_tc||null]);
        } catch {}
      }
      console.log(`[CTB] Routes upserted into ctb.routes (retry)`);
    } else if (ctbRoutes.length === 0) {
      ctbRoutes = ['1', '5B', '10'];
      console.warn('[CTB] API unavailable, using fallback routes');
    }
  }
}

/**
 * GMB routes require resolving route_id and directions for each route_code.
 * We load this once on startup and refresh hourly — the chain is:
 *   GET /route/{region} → list of route_codes
 *   GET /route/{region}/{route_code} → route_id + directions + headways
 */
async function loadGMBRoutes() {
  const regions = ['HKI', 'KLN', 'NT'];
  const loaded  = [];

  for (const region of regions) {
    const data = await get(`${GMB_BASE}/route/${region}`, {}, 20000);
    // GMB wraps the list inside data.data.routes
    const codes = data.data?.routes || data.routes || [];
    console.log(`[GMB] Region ${region}: ${codes.length} route codes`);

    // Resolve route_id and directions for each code (batched)
    await withConcurrency(codes, 5, async (code) => {
      const r = await get(`${GMB_BASE}/route/${region}/${code}`, {}, 15000);
      const entries = r.data?.data || r.data || [];
      for (const entry of entries) {
        if (!entry.route_id) continue;

        // Store headways once per route direction
        for (const dir of (entry.directions || [])) {
          for (const hw of (dir.headways || [])) {
            try {
              await db.query(`
                INSERT INTO gmb.headways
                  (route_id, route_seq, start_time, end_time,
                   frequency, is_weekday, is_holiday)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
                ON CONFLICT DO NOTHING
              `, [
                entry.route_id, dir.route_seq,
                hw.start_time, hw.end_time,
                hw.frequency || null,
                (hw.weekdays || []).some(Boolean),
                hw.public_holiday || false,
              ]);
            } catch {}
          }

          // Store route reference
          try {
            await db.query(`
              INSERT INTO gmb.routes
                (route_id, route_seq, route_code, region, orig_en, dest_en)
              VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT (route_id, route_seq) DO NOTHING
            `, [
              entry.route_id, dir.route_seq, code, region,
              dir.orig_en || null, dir.dest_en || null,
            ]);
          } catch {}
        }

        loaded.push({
          region,
          route_code: code,
          route_id:   entry.route_id,
          directions: entry.directions || [],
        });
      }
      await sleep(50); // gentle rate limit during loading
    });
  }

  gmbRoutes = loaded;
  console.log(`[GMB] Loaded ${gmbRoutes.length} route entries across all regions`);
}

// ── KMB collector ─────────────────────────────────────────────

async function fetchKMBRoute(route) {
  for (const direction of ['outbound', 'inbound']) {
    const dirCode = direction === 'outbound' ? 'O' : 'I';
    const stopsData = await get(`${KMB_BASE}/route-stop/${route}/${direction}/1`, {}, 20000);
    const stops = (stopsData.data || []).slice(0, 15);
    if (!stops.length) continue;

    for (const stop of stops) {
      const stopId = stop.stop;

      // Upsert stop details once per run
      if (!kmbStopCache.has(stopId)) {
        kmbStopCache.set(stopId, true);
        const sd = await get(`${KMB_BASE}/stop/${stopId}`, {}, 20000);
        const d  = sd.data;
        if (d) {
          try {
            await db.query(`
              INSERT INTO kmb.stops (stop_id, name_en, name_tc, lat, lng)
              VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (stop_id) DO NOTHING
            `, [stopId, d.name_en||null, d.name_tc||null,
                d.lat ? parseFloat(d.lat) : null,
                d.long ? parseFloat(d.long) : null]);
          } catch {}
        }
      }

      // Fetch ETA (up to 3 buses per stop)
      const etaData = await get(`${KMB_BASE}/eta/${stopId}/${route}/1`, {}, 20000);
      const etas    = (etaData.data || []).slice(0, 3);
      if (!etas.length) continue;

      for (const e of etas) {
        if (!e.eta) continue;
        const etaHKT  = toHKT(e.eta);
        const now     = nowHKT();
        const waitMin = etaHKT
          ? Math.max(0, Math.round((new Date(etaHKT) - new Date(now)) / 60000))
          : null;
        const rmk    = e.rmk_en || '';
        const isSch  = rmk === 'Scheduled Bus' || rmk === '';
        const { hour, dow } = timeComponents(now);

        try {
          await db.query(`
            INSERT INTO kmb.eta
              (route, dir, stop_id, eta_seq, wait_minutes, eta_timestamp,
               is_scheduled, remarks, fetched_at, hour_of_day, day_of_week)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          `, [route, dirCode, stopId, e.eta_seq||1, waitMin,
              etaHKT, isSch, rmk||null, now, hour, dow]);
          stats.kmb.inserted++;
        } catch (err) {
          stats.kmb.errors++;
        }
      }
      stats.kmb.fetched++;
      await sleep(200);  // 200ms between stops to avoid rate limiting
    }
  }
}

async function runKMBCycle() {
  const start = Date.now();
  console.log(`\n[KMB] Cycle start — ${kmbRoutes.length} routes`);
  await withConcurrency(kmbRoutes, KMB_CONCURRENCY, r =>
    fetchKMBRoute(r).catch(() => { stats.kmb.errors++; })
  );
  stats.kmb.lastCycle = nowHKT();
  console.log(`[KMB] Cycle done in ${((Date.now()-start)/1000).toFixed(1)}s | inserted=${stats.kmb.inserted} errors=${stats.kmb.errors}`);
}

// ── CTB collector ─────────────────────────────────────────────

async function fetchCTBRoute(route) {
  for (const direction of ['outbound', 'inbound']) {
    const dirCode  = direction === 'outbound' ? 'O' : 'I';
    const stopsData = await get(`${CTB_BASE}/route-stop/CTB/${route}/${direction}`, {}, 15000);
    const stops = (stopsData.data || []).slice(0, 15);
    if (!stops.length) continue;

    for (const stop of stops) {
      const stopId = stop.stop;

      if (!ctbStopCache.has(stopId)) {
        ctbStopCache.set(stopId, true);
        const sd = await get(`${CTB_BASE}/stop/${stopId}`, {}, 15000);
        const d  = sd.data;
        if (d) {
          try {
            await db.query(`
              INSERT INTO ctb.stops (stop_id, name_en, name_tc, lat, lng)
              VALUES ($1,$2,$3,$4,$5)
              ON CONFLICT (stop_id) DO NOTHING
            `, [stopId, d.name_en||null, d.name_tc||null,
                d.lat ? parseFloat(d.lat) : null,
                d.long ? parseFloat(d.long) : null]);
          } catch {}
        }
      }

      const etaData = await get(`${CTB_BASE}/eta/CTB/${stopId}/${route}`, {}, 15000);
      const etas    = (etaData.data || [])
        .filter(e => e.dir === dirCode)
        .slice(0, 3);
      if (!etas.length) continue;

      for (const e of etas) {
        if (!e.eta) continue;
        const etaHKT  = toHKT(e.eta);
        const now     = nowHKT();
        const waitMin = etaHKT
          ? Math.max(0, Math.round((new Date(etaHKT) - new Date(now)) / 60000))
          : null;
        const rmk   = e.rmk_en || '';
        const isSch = rmk === 'Scheduled Bus' || rmk === '';
        const { hour, dow } = timeComponents(now);

        try {
          await db.query(`
            INSERT INTO ctb.eta
              (route, dir, stop_id, eta_seq, wait_minutes, eta_timestamp,
               is_scheduled, remarks, fetched_at, hour_of_day, day_of_week)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          `, [route, dirCode, stopId, 1, waitMin,
              etaHKT, isSch, rmk||null, now, hour, dow]);
          stats.ctb.inserted++;
        } catch (err) {
          stats.ctb.errors++;
        }
      }
      stats.ctb.fetched++;
      await sleep(200);
    }
  }
}

async function runCTBCycle() {
  const start = Date.now();
  console.log(`\n[CTB] Cycle start — ${ctbRoutes.length} routes`);
  await withConcurrency(ctbRoutes, CTB_CONCURRENCY, r =>
    fetchCTBRoute(r).catch(() => { stats.ctb.errors++; })
  );
  stats.ctb.lastCycle = nowHKT();
  console.log(`[CTB] Cycle done in ${((Date.now()-start)/1000).toFixed(1)}s | inserted=${stats.ctb.inserted} errors=${stats.ctb.errors}`);
}

// ── GMB collector ─────────────────────────────────────────────

/**
 * GMB uses a 3-step chain per route direction:
 *   1. route_id + route_seq already resolved at startup (in gmbRoutes)
 *   2. GET /route-stop/{route_id}/{route_seq} → stop list with stop_seq
 *   3. GET /eta/route-stop/{route_id}/{route_seq}/{stop_seq} → ETA per stop
 */
async function fetchGMBRoute(entry) {
  const { region, route_code, route_id, directions } = entry;

  for (const dir of directions) {
    const route_seq = dir.route_seq;
    const dirCode   = route_seq === 1 ? 'O' : 'I';

    // Step 2: get stop list
    const r2    = await get(`${GMB_BASE}/route-stop/${route_id}/${route_seq}`, {}, 15000);
    const stops = (r2.data?.data?.route_stops || r2.data?.route_stops || []).slice(0, 15);
    if (!stops.length) continue;

    for (const stop of stops) {
      const { stop_seq, stop_id, name_en, name_tc } = stop;

      // Upsert stop
      try {
        await db.query(`
          INSERT INTO gmb.stops (stop_id, name_en, name_tc, region)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (stop_id) DO NOTHING
        `, [stop_id, name_en||null, name_tc||null, region]);
      } catch {}

      // Step 3: get ETA for this stop
      const r3  = await get(`${GMB_BASE}/eta/route-stop/${route_id}/${route_seq}/${stop_seq}`, {}, 15000);
      const etas = (r3.data?.data?.eta || r3.data?.eta || []).slice(0, 3);
      if (!etas.length) continue;

      for (const e of etas) {
        if (e.diff === null || e.diff === undefined) continue;
        const diff    = parseInt(e.diff, 10);
        const waitMin = Math.max(0, diff);
        const now     = nowHKT();
        // Compute absolute arrival time from diff offset
        const etaHKT  = diff >= 0
          ? toHKT(new Date(Date.now() + diff * 60000))
          : null;
        const rmk   = e.remarks_en || '';
        const isSch = rmk === 'Scheduled' || rmk === '';
        const { hour, dow } = timeComponents(now);

        try {
          await db.query(`
            INSERT INTO gmb.eta
              (route_id, route_code, region, route_seq, stop_id, eta_seq,
               wait_minutes, eta_timestamp, is_scheduled, remarks,
               fetched_at, hour_of_day, day_of_week)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          `, [route_id, route_code, region, route_seq, stop_id,
              e.eta_seq||1, waitMin, etaHKT, isSch, rmk||null,
              now, hour, dow]);
          stats.gmb.inserted++;
        } catch {
          stats.gmb.errors++;
        }
      }
      stats.gmb.fetched++;
      await sleep(150); // GMB API is slower, be more gentle
    }
  }
}

async function runGMBCycle() {
  const start = Date.now();
  console.log(`\n[GMB] Cycle start — ${gmbRoutes.length} route entries`);
  await withConcurrency(gmbRoutes, GMB_CONCURRENCY, r =>
    fetchGMBRoute(r).catch(() => { stats.gmb.errors++; })
  );
  stats.gmb.lastCycle = nowHKT();
  console.log(`[GMB] Cycle done in ${((Date.now()-start)/1000).toFixed(1)}s | inserted=${stats.gmb.inserted} errors=${stats.gmb.errors}`);
}

// ── MTR collector ─────────────────────────────────────────────

async function fetchMTRStation(line, station) {
  const r = await get(`${MTR_BASE}/getSchedule.php`, { line, sta: station });
  if (r.status !== 1) return;

  const stationData = r.data?.[`${line}-${station}`] || {};

  for (const [dirCode, trains] of [['UP', stationData.UP||[]], ['DOWN', stationData.DOWN||[]]]) {
    for (const t of trains.slice(0, 3)) {
      if (!t.time || t.valid !== 'Y') continue;
      const etaHKT  = t.time.replace('T', ' ').substring(0, 23);
      const now     = nowHKT();
      const waitMin = Math.max(0, Math.round((new Date(etaHKT) - new Date(now)) / 60000));
      const { hour, dow } = timeComponents(now);

      try {
        await db.query(`
          INSERT INTO mtr.eta
            (line, station, dir, eta_seq, dest, platform,
             wait_minutes, eta_timestamp, fetched_at, hour_of_day, day_of_week)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [line, station, dirCode, parseInt(t.seq||1,10),
            t.dest||null, t.plat||null, waitMin,
            etaHKT, now, hour, dow]);
        stats.mtr.inserted++;
      } catch {
        stats.mtr.errors++;
      }
    }
    stats.mtr.fetched++;
  }
}

async function runMTRCycle() {
  const start  = Date.now();
  const pairs  = Object.entries(MTR_LINES)
    .flatMap(([line, stations]) => stations.map(sta => [line, sta]));
  console.log(`\n[MTR] Cycle start — ${pairs.length} line-station pairs`);
  await withConcurrency(pairs, MTR_CONCURRENCY, ([line, sta]) =>
    fetchMTRStation(line, sta).catch(() => { stats.mtr.errors++; })
  );
  stats.mtr.lastCycle = nowHKT();
  console.log(`[MTR] Cycle done in ${((Date.now()-start)/1000).toFixed(1)}s | inserted=${stats.mtr.inserted} errors=${stats.mtr.errors}`);
}

// ── Cleanup (delete records older than 16 days) ───────────────
async function cleanup() {
  const cutoff = new Date(Date.now() - 16 * 24 * 3600 * 1000);
  const cutHKT = toHKT(cutoff);
  for (const table of ['kmb.eta', 'ctb.eta', 'gmb.eta', 'mtr.eta']) {
    try {
      const r = await db.query(
        `DELETE FROM ${table} WHERE fetched_at < $1`, [cutHKT]
      );
      if (r.rowCount > 0)
        console.log(`[Cleanup] Deleted ${r.rowCount} old rows from ${table}`);
    } catch {}
  }
}

// ── Polling loops ─────────────────────────────────────────────

function startLoop(name, fn, interval) {
  const loop = async () => {
    try { await fn(); } catch (e) { console.error(`[${name}] cycle error:`, e.message); }
    setTimeout(loop, interval);
  };
  loop();
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('🚌 HK Transit ETA Fetcher starting...');

  // Wait for PostgreSQL
  for (let i = 0; i < 10; i++) {
    try {
      await db.query('SELECT 1');
      console.log('✅ PostgreSQL connected');
      break;
    } catch {
      console.log(`[DB] Waiting for PostgreSQL... (${i+1}/10)`);
      await sleep(3000);
    }
  }

  // Load routes from all APIs
  console.log('📋 Loading routes...');
  await Promise.all([loadKMBRoutes(), loadCTBRoutes()]);
  await loadGMBRoutes(); // sequential — writes headways/routes to DB

  // Refresh route lists every hour
  setInterval(() => Promise.all([loadKMBRoutes(), loadCTBRoutes()]), 3600_000);
  setInterval(() => loadGMBRoutes(), 3600_000);

  // Cleanup old data once per day
  setInterval(cleanup, 24 * 3600_000);

  // Start all 4 polling loops
  console.log('🚀 Starting collection loops...\n');
  startLoop('KMB', runKMBCycle, KMB_INTERVAL);

  // Stagger CTB/GMB/MTR starts to avoid simultaneous bursts
  setTimeout(() => startLoop('CTB', runCTBCycle, CTB_INTERVAL), 5_000);
  setTimeout(() => startLoop('GMB', runGMBCycle, GMB_INTERVAL), 10_000);
  setTimeout(() => startLoop('MTR', runMTRCycle, MTR_INTERVAL), 15_000);
}

// ── Health check endpoint ─────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  stats,
  timestamp: nowHKT(),
}));

app.listen(PORT, () => console.log(`🏥 Health check on port ${PORT}`));

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGTERM', async () => { await db.end(); process.exit(0); });
process.on('SIGINT',  async () => { await db.end(); process.exit(0); });

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
