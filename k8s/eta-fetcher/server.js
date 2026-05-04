/**
 * HK Transit ETA Fetcher Service
 * Collects real-time ETA data from KMB and MTR APIs
 * and stores directly into PostgreSQL (2 schemas: kmb, mtr)
 *
 * Poll intervals:
 *   KMB : every 15 seconds
 *   MTR : every 30 seconds
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
const MTR_BASE = 'https://rt.data.gov.hk/v1/transport/mtr';

// ── Poll intervals ────────────────────────────────────────────
const KMB_INTERVAL = 15_000;   // 15s rest — cycle ~40s, total refresh ~55s
const MTR_INTERVAL = 30_000;   // 30s — static stations, fast

// ── Concurrency limits ────────────────────────────────────────
const KMB_CONCURRENCY = 15;
const MTR_CONCURRENCY = 10;

// ── PostgreSQL pool ───────────────────────────────────────────
const db = new Pool({
  host:     process.env.DB_HOST     || 'postgres',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'hkbus',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 10,
  options:  '-c timezone=Asia/Hong_Kong',
});
db.on('error', err => console.warn('[DB] pool error:', err.message));

// ── In-memory stop detail cache (avoids re-fetching every cycle) ─
const kmbStopCache = new Map(); // stopId → true (already upserted)

// ── Route-stop list cache (refreshed daily via cleanup) ──────────
const kmbRouteStopCache = new Map(); // `${route}:${direction}` → stops[]

// ── Route list (loaded on startup, refreshed daily) ───────────
let kmbRoutes = [];   // ['1','2','5C', ...]
// MTR is static — defined inline below

// ── Stats ─────────────────────────────────────────────────────
const stats = {
  kmb: { fetched: 0, inserted: 0, errors: 0, lastCycle: null },
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

async function get(url, params = {}, timeout = 10000, _retry = 0) {
  try {
    const res = await axios.get(url, { params, timeout, headers: HTTP_HEADERS });
    return res.data || {};
  } catch (e) {
    const status = e.response?.status;
    // 403 or 429 = rate limited — exponential backoff, max 3 retries
    if (status === 403 || status === 429) {
      if (_retry >= 3) {
        console.warn(`[HTTP] ${status} rate limited ${url} — giving up after 3 retries`);
        return {};
      }
      const wait = 10000 * Math.pow(2, _retry); // 10s, 20s, 40s
      console.warn(`[HTTP] ${status} rate limited ${url} — waiting ${wait / 1000}s (retry ${_retry + 1}/3)`);
      await sleep(wait);
      return get(url, params, timeout, _retry + 1);
    }
    console.warn(`[HTTP] FAIL ${url} — ${e.message}`);
    return {};
  }
}

/** Run an array of async tasks with max N in parallel (worker pool — no batch barriers) */
async function withConcurrency(items, concurrency, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      await fn(items[i]).catch(() => {});
    }
  });
  await Promise.all(workers);
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

// ── Route loader ──────────────────────────────────────────────

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

/** Bulk-load all KMB stops in one call — warms stop cache before first cycle */
async function preloadKMBStops() {
  const data = await get(`${KMB_BASE}/stop`, {}, 30000);
  const stops = data.data || [];
  console.log(`[KMB] Preloading ${stops.length} stops...`);
  for (const s of stops) {
    if (kmbStopCache.has(s.stop)) continue;
    kmbStopCache.set(s.stop, true);
    try {
      await db.query(`
        INSERT INTO kmb.stops (stop_id, name_en, name_tc, lat, lng)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (stop_id) DO NOTHING
      `, [s.stop, s.name_en||null, s.name_tc||null,
          s.lat ? parseFloat(s.lat) : null,
          s.long ? parseFloat(s.long) : null]);
    } catch {}
  }
  console.log(`[KMB] Stop cache warmed (${kmbStopCache.size} stops)`);
}

// ── KMB collector ─────────────────────────────────────────────

async function fetchKMBRoute(route) {
  // Build seq→stop_id map from route-stop cache (both directions)
  const seqToStop = { O: {}, I: {} };
  for (const [direction, dirCode] of [['outbound', 'O'], ['inbound', 'I']]) {
    const cacheKey = `${route}:${direction}`;
    let stops = kmbRouteStopCache.get(cacheKey);
    if (!stops) {
      const stopsData = await get(`${KMB_BASE}/route-stop/${route}/${direction}/1`, {}, 20000);
      stops = stopsData.data || [];
      if (stops.length) kmbRouteStopCache.set(cacheKey, stops);
    }
    for (const s of stops) seqToStop[dirCode][s.seq] = s.stop;
  }

  // One call returns ETAs for ALL stops in BOTH directions
  const etaData = await get(`${KMB_BASE}/route-eta/${route}/1`, {}, 20000);
  const etas = etaData.data || [];
  if (!etas.length) return;

  const now = nowHKT();
  const { hour, dow } = timeComponents(now);

  for (const e of etas) {
    if (!e.eta) continue;
    const stopId = seqToStop[e.dir]?.[e.seq];
    if (!stopId) continue;

    // Upsert stop details once per lifetime
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

    const etaHKT  = toHKT(e.eta);
    const waitMin = etaHKT
      ? Math.max(0, Math.round((new Date(etaHKT) - new Date(now)) / 60000))
      : null;
    const rmk   = e.rmk_en || '';
    const isSch = rmk === 'Scheduled Bus' || rmk === '';

    try {
      await db.query(`
        INSERT INTO kmb.eta
          (route, dir, stop_id, eta_seq, wait_minutes, eta_timestamp,
           is_scheduled, remarks, fetched_at, hour_of_day, day_of_week)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [route, e.dir, stopId, e.eta_seq||1, waitMin,
          etaHKT, isSch, rmk||null, now, hour, dow]);
      stats.kmb.inserted++;
    } catch {
      stats.kmb.errors++;
    }
    stats.kmb.fetched++;
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
  for (const table of ['kmb.eta', 'mtr.eta']) {
    try {
      const r = await db.query(
        `DELETE FROM ${table} WHERE fetched_at < $1`, [cutHKT]
      );
      if (r.rowCount > 0)
        console.log(`[Cleanup] Deleted ${r.rowCount} old rows from ${table}`);
    } catch {}
  }
  kmbRouteStopCache.clear();
  console.log('[Cleanup] Route-stop cache cleared');
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

  // Load KMB routes, then warm stop cache before first cycle
  console.log('📋 Loading routes...');
  await loadKMBRoutes();

  console.log('🔥 Pre-warming stop cache...');
  await preloadKMBStops();
  console.log('✅ Stop cache ready — first cycle will be fast');

  // Refresh route list once per day (routes change very rarely)
  setInterval(loadKMBRoutes, 24 * 3600_000);

  // Refresh materialized reliability view hourly
  setInterval(async () => {
    try {
      await db.query('REFRESH MATERIALIZED VIEW CONCURRENTLY kmb.mv_route_reliability');
      console.log('[Analytics] mv_route_reliability refreshed');
    } catch (e) { console.warn('[Analytics] refresh failed:', e.message); }
  }, 3600_000);

  // Cleanup old data once per day
  setInterval(cleanup, 24 * 3600_000);

  // Start KMB and MTR loops
  console.log('🚀 Starting KMB and MTR collection loops...\n');
  startLoop('KMB', runKMBCycle, KMB_INTERVAL);
  setTimeout(() => startLoop('MTR', runMTRCycle, MTR_INTERVAL), 5_000);
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
