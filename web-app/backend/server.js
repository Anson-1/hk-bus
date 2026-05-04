const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

const Redis = require('ioredis');
const { Pool } = require('pg');
const KMB_API_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';

const pgPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'hkbus',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
pgPool.on('error', (err) => console.warn('[PG] pool error:', err.message));
const CTB_API_BASE = 'https://rt.data.gov.hk/v2/transport/citybus';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
redis.on('error', (err) => console.warn('[Redis] connection error:', err.message));
redis.connect().catch(() => console.warn('[Redis] could not connect — falling back to in-memory cache'));

const routeCache = {};
const stopCache = {};
const routeSubscribers = {};
const lastBroadcastData = {};

function broadcastRouteUpdate(routeNum, data) {
  const dataString = JSON.stringify(data);
  if (lastBroadcastData[routeNum] === dataString) return;
  lastBroadcastData[routeNum] = dataString;
  io.to(`route:${routeNum}`).emit('route_update', {
    route: routeNum,
    data: data,
    timestamp: new Date().toISOString()
  });
}

async function getStopDetails(stopId) {
  const redisKey = `stop:${stopId}`;
  try {
    const cached = await redis.get(redisKey);
    if (cached) return JSON.parse(cached);
  } catch {}
  if (stopCache[stopId]) return stopCache[stopId];

  try {
    const response = await axios.get(`${KMB_API_BASE}/stop/${stopId}`, { timeout: 5000 });
    if (response.data && response.data.data) {
      const s = response.data.data;
      const result = {
        stop_id: stopId,
        name_en: s.name_en || '',
        name_tc: s.name_tc || '',
        lat: parseFloat(s.lat),
        long: parseFloat(s.long),
      };
      stopCache[stopId] = result;
      redis.setex(redisKey, 86400, JSON.stringify(result)).catch(() => {});
      return result;
    }
  } catch (error) {
    console.warn(`Failed to fetch stop details for ${stopId}:`, error.message);
  }

  const fallback = { stop_id: stopId, name_en: `Stop ${stopId.substring(0, 8)}`, name_tc: '' };
  stopCache[stopId] = fallback;
  return fallback;
}

async function getRouteDetails(routeNum, direction = 'O') {
  if (!routeNum) return { route: routeNum, name: 'Unknown Route', name_tc: '未知路線' };

  const cacheKey = `${routeNum}_${direction}`;
  if (routeCache[cacheKey]) return routeCache[cacheKey];

  try {
    const response = await axios.get(`${KMB_API_BASE}/route`, { params: { routes: routeNum }, timeout: 3000 });
    if (response.data && response.data.data && response.data.data.length > 0) {
      const routes = response.data.data;
      const matchingRoutes = routes.filter(r => r.route === routeNum);
      let matched = matchingRoutes.find(r => r.bound === direction && r.service_type === '1')
        || matchingRoutes.find(r => r.bound === direction)
        || (matchingRoutes.length > 0 ? matchingRoutes[0] : routes[0]);

      routeCache[cacheKey] = {
        route: routeNum,
        name: `${matched.orig_en} → ${matched.dest_en}`,
        name_tc: `${matched.orig_tc} → ${matched.dest_tc}`,
      };
      return routeCache[cacheKey];
    }
  } catch (e) {
    console.error(`Error fetching route ${routeNum}:`, e.message);
  }

  return { route: routeNum, name: `Route ${routeNum}`, name_tc: `路線 ${routeNum}` };
}

// ============================================================
// ROUTES
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/metrics', (req, res) => {
  const redisStatus = redis.status === 'ready' ? 1 : 0;
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send([
    '# HELP hk_bus_api_up Backend API health status',
    '# TYPE hk_bus_api_up gauge',
    'hk_bus_api_up 1',
    '# HELP hk_bus_api_uptime_seconds Process uptime in seconds',
    '# TYPE hk_bus_api_uptime_seconds gauge',
    `hk_bus_api_uptime_seconds ${process.uptime().toFixed(2)}`,
    '# HELP hk_bus_api_route_cache_size Number of cached routes (in-memory)',
    '# TYPE hk_bus_api_route_cache_size gauge',
    `hk_bus_api_route_cache_size ${Object.keys(routeCache).length}`,
    '# HELP hk_bus_redis_up Redis connection status',
    '# TYPE hk_bus_redis_up gauge',
    `hk_bus_redis_up ${redisStatus}`,
    '',
  ].join('\n'));
});

app.get('/api/stops/:stopId', async (req, res) => {
  try {
    const { stopId } = req.params;
    const response = await axios.get(`${KMB_API_BASE}/stop/${stopId}`, { timeout: 5000 });
    if (response.data && response.data.data) {
      const stop = response.data.data;
      res.json({
        stop_id: stop.stop,
        name_en: stop.name_en || '',
        name_tc: stop.name_tc || '',
        lat: parseFloat(stop.lat),
        long: parseFloat(stop.long),
      });
    } else {
      res.status(404).json({ error: 'Stop not found' });
    }
  } catch (error) {
    console.error('Error fetching stop:', error.message);
    res.status(500).json({ error: 'Failed to fetch stop details' });
  }
});

app.get('/api/eta/:stopId', async (req, res) => {
  try {
    const { stopId } = req.params;

    const [stopResponse, etaResponse] = await Promise.allSettled([
      axios.get(`${KMB_API_BASE}/stop/${stopId}`, { timeout: 5000 }),
      axios.get(`${KMB_API_BASE}/stop-eta/${stopId}`, { timeout: 5000 }),
    ]);

    let stopInfo = null;
    if (stopResponse.status === 'fulfilled' && stopResponse.value.data?.data) {
      const s = stopResponse.value.data.data;
      stopInfo = {
        stop_id: s.stop,
        name_en: s.name_en,
        name_tc: s.name_tc,
        lat: parseFloat(s.lat),
        long: parseFloat(s.long),
      };
    }

    let etas = [];
    if (etaResponse.status === 'fulfilled' && etaResponse.value.data?.data) {
      const now = new Date();
      etas = etaResponse.value.data.data
        .filter(e => e.eta)
        .map(e => ({
          route: e.route,
          dir: e.dir,
          dest_en: e.dest_en,
          dest_tc: e.dest_tc,
          wait_sec: Math.max(0, Math.round((new Date(e.eta) - now) / 1000)),
          eta: e.eta,
          rmk_en: e.rmk_en,
        }));
    }

    res.json({ stop: stopInfo, etas, count: etas.length, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Error fetching ETAs:', error.message);
    res.status(500).json({ error: 'Failed to fetch ETAs' });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) return res.status(400).json({ error: 'Query parameter required' });

    const response = await axios.get(`${KMB_API_BASE}/stop`, { timeout: 5000 });
    if (response.data && response.data.data) {
      const searchTerm = q.toLowerCase();
      const results = response.data.data.filter(stop => {
        return stop.stop.toLowerCase().includes(searchTerm)
          || (stop.name_en && stop.name_en.toLowerCase().includes(searchTerm))
          || (stop.name_tc && stop.name_tc.includes(searchTerm));
      }).slice(0, 20);

      res.json({
        query: q,
        results: results.map(stop => ({
          stop_id: stop.stop,
          name_en: stop.name_en,
          name_tc: stop.name_tc,
          lat: parseFloat(stop.lat),
          long: parseFloat(stop.long),
        })),
        count: results.length,
      });
    } else {
      res.json({ query: q, results: [], count: 0 });
    }
  } catch (error) {
    console.error('Error searching stops:', error.message);
    res.status(500).json({ error: 'Failed to search stops' });
  }
});

app.get('/api/route-search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) return res.status(400).json({ error: 'Query parameter required' });

    const searchTerm = q.toUpperCase().trim();

    const kmbRes = await axios.get(`${KMB_API_BASE}/route`, { timeout: 5000 }).catch(() => null);

    const results = kmbRes?.data?.data
      ? kmbRes.data.data
          .filter(r => r.service_type === '1')
          .filter(r =>
            r.route.toUpperCase().startsWith(searchTerm) ||
            r.orig_en?.toUpperCase().includes(searchTerm) ||
            r.dest_en?.toUpperCase().includes(searchTerm)
          )
          .slice(0, 20)
          .map(r => ({ route: r.route, bound: r.bound, company: 'KMB', name_en: `${r.orig_en} → ${r.dest_en}` }))
      : [];

    res.json({ query: q, results, count: results.length });
  } catch (error) {
    console.error('Error in route search:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/routes', async (req, res) => {
  try {
    const result = await pgPool.query(
      'SELECT route, bound, orig_en, orig_tc, dest_en, dest_tc FROM kmb.routes ORDER BY route, bound LIMIT 100'
    );
    res.json({ routes: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching routes:', error.message);
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

app.get('/api/route/:route/:direction', async (req, res) => {
  try {
    const { route, direction } = req.params;
    const response = await axios.get(`${KMB_API_BASE}/route-stop/${route}/${direction}`, { timeout: 5000 });
    if (response.data && response.data.data) {
      res.json({
        route,
        direction,
        stops: response.data.data.map((item, idx) => ({
          sequence: idx + 1,
          stop_id: item.stop,
          stop_seq: item.seq,
        })),
        count: response.data.data.length,
      });
    } else {
      res.json({ route, direction, stops: [], count: 0 });
    }
  } catch (error) {
    console.error('Error fetching route stops:', error.message);
    res.status(500).json({ error: 'Failed to fetch route stops' });
  }
});

app.get('/api/alerts/recent', async (req, res) => {
  try {
    const result = await pgPool.query(
      `SELECT * FROM delay_alerts WHERE alerted_at > NOW() - INTERVAL '1 hour' ORDER BY alerted_at DESC LIMIT 50`
    );
    res.json({ alerts: result.rows });
  } catch (err) {
    res.json({ alerts: [] });
  }
});

app.get('/api/route-live/:routeNum', async (req, res) => {
  try {
    const { routeNum } = req.params;
    const requestedBound = req.query.bound;
    const cacheKey = `route-live:${routeNum}:${requestedBound || 'O'}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    } catch {}

    let stopsResponse = null;
    let direction = 'O';

    const directionWord = requestedBound === 'I' ? 'inbound' : 'outbound';
    const fallbackWord  = requestedBound === 'I' ? 'outbound' : 'inbound';
    const fallbackBound = requestedBound === 'I' ? 'O' : 'I';

    try {
      stopsResponse = await axios.get(`${KMB_API_BASE}/route-stop/${routeNum}/${directionWord}/1`, { timeout: 5000 });
      direction = requestedBound || 'O';
    } catch (e) {
      if (!requestedBound) {
        try {
          stopsResponse = await axios.get(`${KMB_API_BASE}/route-stop/${routeNum}/${fallbackWord}/1`, { timeout: 5000 });
          direction = fallbackBound;
        } catch (e2) {
          return res.json({ route: { route: routeNum, name: 'Route not found', name_tc: '路線不存在' }, stops: [] });
        }
      } else {
        return res.json({ route: { route: routeNum, name: 'Route not found', name_tc: '路線不存在' }, stops: [] });
      }
    }

    const routeDetails = await getRouteDetails(routeNum, direction);

    if (!stopsResponse.data || !stopsResponse.data.data) {
      return res.json({ route: { route: routeNum, name: routeDetails.name, name_tc: routeDetails.name_tc }, stops: [] });
    }

    const stopList = stopsResponse.data.data.slice(0, 35);

    const stopsWithLiveETA = await Promise.all(
      stopList.map(async (stop) => {
        try {
          const stopDetails = await getStopDetails(stop.stop);

          let waitSec = null;
          let rmk_en = '';
          try {
            const etaResponse = await axios.get(`${KMB_API_BASE}/eta/${stop.stop}/${routeNum}/1`, { timeout: 5000 });
            if (etaResponse.data?.data?.length > 0) {
              const firstEta = etaResponse.data.data[0];
              if (firstEta.eta) {
                waitSec = Math.max(0, Math.round((new Date(firstEta.eta) - new Date()) / 1000));
                rmk_en = firstEta.rmk_en || '';
              }
            }
          } catch (etaErr) {}

          return {
            stop_id: stop.stop,
            sequence: stop.seq,
            name: stopDetails.name_en || `Stop ${stop.seq}`,
            name_en: stopDetails.name_en || '',
            name_tc: stopDetails.name_tc || '',
            lat: stopDetails.lat,
            lng: stopDetails.long,
            wait_sec: waitSec,
            rmk_en,
            is_live: true,
          };
        } catch (err) {
          return {
            stop_id: stop.stop,
            sequence: stop.seq,
            name: `Stop ${stop.seq}`,
            name_en: '', name_tc: '',
            lat: null, lng: null,
            wait_sec: null,
            is_live: true,
          };
        }
      })
    );

    const responseData = {
      route: { route: routeNum, name: routeDetails.name, name_tc: routeDetails.name_tc },
      stops: stopsWithLiveETA,
      totalStops: stopsResponse.data.data.length,
      stopsWithData: stopsWithLiveETA.filter(s => s.wait_sec !== null).length,
      timestamp: new Date().toISOString(),
    };

    redis.setex(cacheKey, 15, JSON.stringify(responseData)).catch(() => {});
    res.json(responseData);
    broadcastRouteUpdate(routeNum, responseData);
  } catch (error) {
    console.error('Error fetching live route details:', error.message);
    res.status(500).json({ error: 'Failed to fetch live route details' });
  }
});

// Returns per-stop avg wait seconds from eta_realtime (via eta-aggregator service)
app.get('/api/avg-wait/:route/:dir', async (req, res) => {
  const { route, dir } = req.params;
  const aggregatorUrl = process.env.ETA_AGGREGATOR_URL || 'http://eta-aggregator.hk-bus.svc.cluster.local:3003';

  try {
    const response = await axios.get(`${aggregatorUrl}/realtime`, {
      params: { route, dir },
      timeout: 3000,
    });

    // Convert array to map keyed by stop_id for easy frontend lookup
    const stopMap = {};
    for (const row of (response.data.stops || [])) {
      stopMap[row.stop_id] = {
        avg_wait_sec: Math.round(row.avg_wait_sec),
        sample_count: row.sample_count,
        window_start: row.window_start,
      };
    }

    res.json({ route, dir, stops: stopMap });
  } catch (err) {
    // Return empty map so the frontend degrades gracefully
    res.json({ route, dir, stops: {} });
  }
});

app.get('/api/route-live-ctb/:routeNum', async (req, res) => {
  try {
    const { routeNum } = req.params;
    const requestedBound = req.query.bound || 'O';
    const cacheKey = `route-live-ctb:${routeNum}:${requestedBound}`;
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    } catch {}

    const direction = requestedBound === 'I' ? 'inbound' : 'outbound';

    const stopsRes = await axios.get(
      `${CTB_API_BASE}/route-stop/CTB/${routeNum}/${direction}`,
      { timeout: 5000 }
    );
    const stopList = (stopsRes.data?.data || []).slice(0, 35);
    if (stopList.length === 0) {
      return res.json({ route: { route: routeNum, name: 'Route not found', name_tc: '' }, stops: [] });
    }

    // Get route name — swap orig/dest for inbound
    let routeName = `Route ${routeNum}`;
    let routeNameTc = '';
    try {
      const routeRes = await axios.get(`${CTB_API_BASE}/route/CTB`, { timeout: 5000 });
      const matched = routeRes.data?.data?.find(r => r.route === routeNum);
      if (matched) {
        if (requestedBound === 'I') {
          routeName = `${matched.dest_en} → ${matched.orig_en}`;
          routeNameTc = `${matched.dest_tc} → ${matched.orig_tc}`;
        } else {
          routeName = `${matched.orig_en} → ${matched.dest_en}`;
          routeNameTc = `${matched.orig_tc} → ${matched.dest_tc}`;
        }
      }
    } catch {}

    const stopsWithETA = await Promise.all(
      stopList.map(async (stop) => {
        const stopId = stop.stop;
        let name_en = '', name_tc = '', lat = null, lng = null, wait_sec = null;

        try {
          const stopRes = await axios.get(`${CTB_API_BASE}/stop/${stopId}`, { timeout: 5000 });
          const s = stopRes.data?.data;
          if (s) {
            name_en = s.name_en || '';
            name_tc = s.name_tc || '';
            lat = parseFloat(s.lat);
            lng = parseFloat(s.long);
          }
        } catch {}

        let rmk_en = '';
        try {
          const etaRes = await axios.get(`${CTB_API_BASE}/eta/CTB/${stopId}/${routeNum}`, { timeout: 5000 });
          const etas = (etaRes.data?.data || []).filter(e => e.eta && e.dir === requestedBound);
          if (etas.length > 0) {
            wait_sec = Math.max(0, Math.round((new Date(etas[0].eta) - new Date()) / 1000));
            rmk_en = etas[0].rmk_en || '';
          }
        } catch {}

        return { stop_id: stopId, sequence: stop.seq, name: name_en || `Stop ${stop.seq}`, name_en, name_tc, lat, lng, wait_sec, rmk_en, is_live: true };
      })
    );

    const responseData = {
      route: { route: routeNum, name: routeName, name_tc: routeNameTc, company: 'CTB' },
      stops: stopsWithETA,
      totalStops: stopList.length,
      stopsWithData: stopsWithETA.filter(s => s.wait_sec !== null).length,
      timestamp: new Date().toISOString(),
    };
    redis.setex(cacheKey, 15, JSON.stringify(responseData)).catch(() => {});
    res.json(responseData);
    broadcastRouteUpdate(routeNum, responseData);
  } catch (error) {
    console.error('Error fetching CTB live route:', error.message);
    res.status(500).json({ error: 'Failed to fetch CTB route details' });
  }
});

const MTR_LINES = {
  AEL: { name: 'Airport Express', stations: { HOK: 'Hong Kong', KOW: 'Kowloon', TSY: 'Tsing Yi', AIR: 'Airport', AWE: 'AsiaWorld-Expo' } },
  TCL: { name: 'Tung Chung Line', stations: { HOK: 'Hong Kong', KOW: 'Kowloon', OLY: 'Olympic', NAC: 'Nam Cheong', LAK: 'Lai King', TUC: 'Tsing Yi', SUN: 'Sunny Bay', TIO: 'Tung Chung' } },
  TML: { name: 'Tuen Ma Line', stations: { WKS: 'Wu Kai Sha', SHM: 'Shek Mun', CIO: 'City One', STW: 'Sha Tin Wai', CKT: 'Che Kung Temple', TAW: 'Tai Wai', HIK: 'Hin Keng', DIH: 'Diamond Hill', KAT: 'Kai Tak', SUW: 'Sung Wong Toi', TKW: 'To Kwa Wan', HOM: 'Ho Man Tin', HUH: 'Hung Hom', ETS: 'East Tsim Sha Tsui', AUS: 'Austin', NAC: 'Nam Cheong', LOP: 'Lok On Pai', YUL: 'Yuen Long', KSR: 'Kam Sheung Road', TIS: 'Tin Shui Wai', SIH: 'Siu Hong', TUM: 'Tuen Mun' } },
  TWL: { name: 'Tsuen Wan Line', stations: { CEN: 'Central', ADM: 'Admiralty', TST: 'Tsim Sha Tsui', JOR: 'Jordan', YMT: 'Yau Ma Tei', MOK: 'Mong Kok', PRE: 'Prince Edward', SKM: 'Shek Kip Mei', LAT: 'Lai Chi Kok', CSW: 'Cheung Sha Wan', SSP: 'Sham Shui Po', LCK: 'Lai King', KWH: 'Kwai Hing', KWF: 'Kwai Fong', MEF: 'Mei Foo', TWW: 'Tsuen Wan West', TSW: 'Tsuen Wan' } },
  ISL: { name: 'Island Line', stations: { KET: 'Kennedy Town', HKU: 'HKU', SYP: 'Sai Ying Pun', SHW: 'Sheung Wan', CEN: 'Central', ADM: 'Admiralty', WAC: 'Wan Chai', CAB: 'Causeway Bay', TIH: 'Tin Hau', FOH: 'Fortress Hill', NOP: 'North Point', QUB: 'Quarry Bay', TAK: 'Tai Koo', SWH: 'Sai Wan Ho', SKW: 'Shau Kei Wan', HFC: 'Heng Fa Chuen', CHW: 'Chai Wan' } },
  KTL: { name: 'Kwun Tong Line', stations: { WHA: 'Whampoa', HOM: 'Ho Man Tin', YMT: 'Yau Ma Tei', MOK: 'Mong Kok', PRE: 'Prince Edward', SKM: 'Shek Kip Mei', KOT: 'Kowloon Tong', LOF: 'Lok Fu', WTS: 'Wong Tai Sin', DIH: 'Diamond Hill', CHH: 'Choi Hung', KOB: 'Kowloon Bay', NTK: 'Ngau Tau Kok', KWT: 'Kwun Tong', LAT: 'Lam Tin', TIK: 'Tiu Keng Leng' } },
  EAL: { name: 'East Rail Line', stations: { ADM: 'Admiralty', EXH: 'Exhibition Centre', HUH: 'Hung Hom', MKK: 'Mong Kok East', KOT: 'Kowloon Tong', STK: 'Sha Tin', TAW: 'Tai Wai', SHT: 'Sha Tin', FO: 'Fo Tan', UNI: 'University', TAP: 'Tai Po Market', TWO: 'Tai Wo', FAN: 'Fanling', SHS: 'Sheung Shui', LOW: 'Lo Wu', LMC: 'Lok Ma Chau' } },
  SIL: { name: 'South Island Line', stations: { ADM: 'Admiralty', OCP: 'Ocean Park', WCH: 'Wong Chuk Hang', LET: 'Lei Tung', SOH: 'South Horizons' } },
  TKL: { name: 'Tseung Kwan O Line', stations: { NOP: 'North Point', QUB: 'Quarry Bay', YAT: 'Yau Tong', TIK: 'Tiu Keng Leng', TKO: 'Tseung Kwan O', LHP: 'LOHAS Park', POA: 'Po Lam', HAH: 'Hang Hau' } },
  DRL: { name: 'Disneyland Resort Line', stations: { SUN: 'Sunny Bay', DIS: 'Disneyland Resort' } },
};

app.get('/api/mtr-lines', (req, res) => {
  res.json(MTR_LINES);
});

app.get('/api/mtr-eta', async (req, res) => {
  const { line, station } = req.query;
  if (!line || !station) return res.status(400).json({ error: 'line and station required' });

  try {
    const response = await axios.get('https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php', {
      params: { line, sta: station },
      timeout: 8000,
    });

    const key = `${line}-${station}`;
    const raw = response.data?.data?.[key];
    if (!raw) return res.json({ line, station, up: [], down: [], curr_time: null });

    const parseDir = (arr) => (arr || []).map(e => ({
      seq: e.seq,
      dest: e.dest,
      dest_name: MTR_LINES[line]?.stations?.[e.dest] || e.dest,
      platform: e.plat,
      time: e.time,
      wait_min: Math.max(0, Math.round((new Date(e.time.replace(' ', 'T') + '+08:00') - new Date()) / 60000)),
    }));

    res.json({
      line,
      station,
      station_name: MTR_LINES[line]?.stations?.[station] || station,
      line_name: MTR_LINES[line]?.name || line,
      up: parseDir(raw.UP),
      down: parseDir(raw.DOWN),
      curr_time: raw.curr_time,
    });
  } catch (err) {
    console.error('[MTR ETA]', err.message);
    res.status(500).json({ error: 'Failed to fetch MTR ETA' });
  }
});

// ============================================================

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;

io.on('connection', (socket) => {
  console.log(`[WebSocket] Client connected: ${socket.id}`);

  socket.on('subscribe', (routeNum) => {
    if (!routeSubscribers[routeNum]) routeSubscribers[routeNum] = new Set();
    routeSubscribers[routeNum].add(socket.id);
    socket.join(`route:${routeNum}`);
    socket.emit('subscribed', { route: routeNum });
  });

  socket.on('unsubscribe', (routeNum) => {
    if (routeSubscribers[routeNum]) routeSubscribers[routeNum].delete(socket.id);
    socket.leave(`route:${routeNum}`);
  });

  socket.on('disconnect', () => {
    Object.keys(routeSubscribers).forEach(route => {
      routeSubscribers[route].delete(socket.id);
    });
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.status(500).json({ error: 'Could not serve index.html' });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 HK Bus API Server running on port ${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/health`);
});

process.on('SIGINT', () => {
  console.log('\n✅ Shutting down gracefully...');
  process.exit(0);
});
