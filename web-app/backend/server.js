const express = require('express');
const { Pool } = require('pg');
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

// Serve frontend static files from public directory
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-db.hk-bus.svc.cluster.local',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'hk_bus',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// KMB API base URL
const KMB_API_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';

// Monitored routes
const MONITORED_ROUTES = ['1', '1A', '2', '3C', '5', '6', '6C', '9', '11', '12', '13D', '15', '26', '40', '42C', '68X', '74B', '91M', '91P', '98D', '270', 'N8'];

// Cache for route info
const routeCache = {};

// Cache for stop info
const stopCache = {};

// Track connected clients per route
const routeSubscribers = {}; // routeNum -> Set of socket IDs

// Store last broadcast data to avoid duplicate sends
const lastBroadcastData = {}; // routeNum -> JSON string of data

/**
 * Broadcast route updates to all subscribed clients
 */
function broadcastRouteUpdate(routeNum, data) {
  const dataString = JSON.stringify(data);
  
  // Only broadcast if data has changed
  if (lastBroadcastData[routeNum] === dataString) {
    return;
  }
  
  lastBroadcastData[routeNum] = dataString;
  io.to(`route:${routeNum}`).emit('route_update', {
    route: routeNum,
    data: data,
    timestamp: new Date().toISOString()
  });
}

/**
 * Get stop details from KMB API (with caching)
 */
async function getStopDetails(stopId) {
  if (stopCache[stopId]) {
    return stopCache[stopId];
  }

  try {
    const response = await axios.get(`${KMB_API_BASE}/stop/${stopId}`, {
      timeout: 5000
    });

    // Response format: response.data.data (object, not array)
    if (response.data && response.data.data) {
      const stopData = response.data.data;
      stopCache[stopId] = {
        stop_id: stopId,
        name_en: stopData.name_en || '',
        name_tc: stopData.name_tc || '',
        lat: parseFloat(stopData.lat),
        long: parseFloat(stopData.long),
      };
      return stopCache[stopId];
    }
  } catch (error) {
    console.warn(`Failed to fetch stop details for ${stopId}:`, error.message);
  }

  // Return minimal info as fallback
  stopCache[stopId] = {
    stop_id: stopId,
    name_en: `Stop ${stopId.substring(0, 8)}`,
    name_tc: '',
  };
  return stopCache[stopId];
}

/**
 * Get route details from KMB API (with caching)
 * Fetches destination information for a specific route
 */
async function getRouteDetails(routeNum, direction = 'O') {
  if (!routeNum) {
    return { route: routeNum, name: 'Unknown Route', name_tc: '未知路線' };
  }
  
  // Use direction in cache key to get correct destination
  const cacheKey = `${routeNum}_${direction}`;
  if (routeCache[cacheKey]) {
    return routeCache[cacheKey];
  }
  
  try {
    // Fetch all variants of this route from KMB API
    const response = await axios.get(`${KMB_API_BASE}/route`, {
      params: { routes: routeNum },
      timeout: 3000
    });
    
    if (response.data && response.data.data && response.data.data.length > 0) {
      // Find the matching direction (prefer service_type 1, then others)
      let matchedRoute = null;
      const routes = response.data.data;
      
      // Filter to only routes matching the requested route number
      const matchingRoutes = routes.filter(r => r.route === routeNum);
      
      // First, look for exact bound match with service_type 1
      matchedRoute = matchingRoutes.find(r => r.bound === direction && r.service_type === '1');
      
      // If not found, accept any matching bound
      if (!matchedRoute) {
        matchedRoute = matchingRoutes.find(r => r.bound === direction);
      }
      
      // If still not found, try the first route from API (fallback)
      if (!matchedRoute) {
        matchedRoute = matchingRoutes.length > 0 ? matchingRoutes[0] : routes[0];
      }
      
      routeCache[cacheKey] = {
        route: routeNum,
        name: `${matchedRoute.orig_en} → ${matchedRoute.dest_en}`,
        name_tc: `${matchedRoute.orig_tc} → ${matchedRoute.dest_tc}`,
      };
      console.log(`Fetched route ${routeNum} (${direction}): ${routeCache[cacheKey].name}`);
      return routeCache[cacheKey];
    }
  } catch (e) {
    console.error(`Error fetching route ${routeNum}:`, e.message);
  }
  
  // Fallback
  return { route: routeNum, name: `Route ${routeNum}`, name_tc: `路線 ${routeNum}` };
}

// ============================================================
// ROUTES
// ============================================================

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /api/stops/:stopId
 * Get bus stop details (location, name, etc.)
 */
app.get('/api/stops/:stopId', async (req, res) => {
  try {
    const { stopId } = req.params;

    // Fetch from KMB API
    const response = await axios.get(`${KMB_API_BASE}/stop/${stopId}`, {
      timeout: 5000
    });

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

/**
 * GET /api/eta/:stopId
 * Get real-time ETAs for a specific bus stop
 * Returns aggregated ETA data from Kafka stream processing
 */
app.get('/api/eta/:stopId', async (req, res) => {
  try {
    const { stopId } = req.params;

    // Get stop info from KMB API
    let stopInfo = null;
    try {
      const stopResponse = await axios.get(`${KMB_API_BASE}/stop/${stopId}`, {
        timeout: 3000
      });
      if (stopResponse.data && stopResponse.data.data) {
        const stop = stopResponse.data.data;
        stopInfo = {
          stop_id: stop.stop,
          name_en: stop.name_en,
          name_tc: stop.name_tc,
          lat: parseFloat(stop.lat),
          long: parseFloat(stop.long),
        };
      }
    } catch (e) {
      console.error('Error fetching stop info:', e.message);
      // If we can't get stop info, still show available ETA data
    }

    // Query PostgreSQL for latest ETA data for THIS specific stop
    // Aggregate fresh raw ETA data (last 5 minutes) instead of waiting for Spark
    const query = `
      SELECT
        route,
        dir,
        ROUND(AVG(EXTRACT(EPOCH FROM (eta - NOW())))::numeric, 0) AS wait_sec,
        COUNT(*) as sample_count,
        MAX(fetched_at)::timestamp AS window_start,
        (MAX(rmk_en) ILIKE '%delay%') AS is_delayed
      FROM eta_raw
      WHERE stop = $1
        AND fetched_at > NOW() - INTERVAL '5 minutes'
        AND route IS NOT NULL 
        AND route != ''
        AND eta IS NOT NULL
      GROUP BY route, dir
      ORDER BY window_start DESC, route ASC
      LIMIT 50
    `;

    const result = await pool.query(query, [stopId]);

    // Enrich ETAs with route details (show all routes)
    const enrichedETAs = await Promise.all(
      result.rows.map(async (row) => {
        const routeDetails = await getRouteDetails(row.route, row.dir);
        return {
          ...row,
          route_name: routeDetails.name,
          route_name_tc: routeDetails.name_tc,
        };
      })
    );

    res.json({
      stop: stopInfo,
      etas: enrichedETAs,
      count: enrichedETAs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching ETAs:', error.message);
    res.status(500).json({ error: 'Failed to fetch ETAs' });
  }
});

/**
 * GET /api/search
 * Search for bus stops by name or ID
 */
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 1) {
      return res.status(400).json({ error: 'Query parameter required' });
    }

    // Try to fetch from KMB API (returns stop by ID or name search)
    try {
      const response = await axios.get(`${KMB_API_BASE}/stop`, {
        timeout: 5000
      });

      if (response.data && response.data.data) {
        const stops = response.data.data;
        const searchTerm = q.toLowerCase();

        // Filter stops by ID or name
        const results = stops.filter(stop => {
          const matchId = stop.stop.toLowerCase().includes(searchTerm);
          const matchName = (stop.name_en && stop.name_en.toLowerCase().includes(searchTerm)) ||
                           (stop.name_tc && stop.name_tc.includes(searchTerm));
          return matchId || matchName;
        }).slice(0, 20); // Limit to 20 results

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
    } catch (e) {
      console.error('Error searching stops:', e.message);
      res.status(500).json({ error: 'Failed to search stops' });
    }
  } catch (error) {
    console.error('Error in search endpoint:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/route-search
 * Search for routes
 */
app.get('/api/route-search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.length < 1) {
      return res.status(400).json({ error: 'Query parameter required' });
    }

    // Common HK routes - return matching ones
    const COMMON_ROUTES = [
      { route: '1', name_en: 'CHUK YUEN ESTATE → STAR FERRY' },
      { route: '1A', name_en: 'JORDAN ROAD → STAR FERRY' },
      { route: '2', name_en: 'CHUK YUEN ESTATE → ADMIRALTY' },
      { route: '2B', name_en: 'CHUK YUEN ESTATE → CHEUNG SHA WAN' },
      { route: '3', name_en: 'CHUK YUEN ESTATE → CENTRAL' },
      { route: '3C', name_en: 'CHUK YUEN ESTATE → ADMIRALTY' },
      { route: '6', name_en: 'CHUK YUEN ESTATE → CENTRAL' },
      { route: '11', name_en: 'SAU MAU PING → STAR FERRY' },
      { route: '11C', name_en: 'CHUK YUEN ESTATE → SAU MAU PING' },
      { route: '11K', name_en: 'CHUK YUEN ESTATE → HUNG HOM STATION' },
      { route: '103', name_en: 'CHUK YUEN ESTATE → POKFIELD RD' },
      { route: '260', name_en: 'CHUK YUEN ESTATE → KWAI CHUNG' },
    ];

    const searchTerm = q.toLowerCase().trim();
    const results = COMMON_ROUTES.filter(route => 
      route.route.toLowerCase().includes(searchTerm) ||
      route.name_en.toLowerCase().includes(searchTerm)
    );

    res.json({
      query: q,
      results: results,
      count: results.length,
    });
  } catch (error) {
    console.error('Error in route search:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/routes
 * Get list of all routes
 */
app.get('/api/routes', async (req, res) => {
  try {
    const response = await axios.get(`${KMB_API_BASE}/routes`, {
      timeout: 5000
    });

    if (response.data && response.data.data) {
      const routes = response.data.data.slice(0, 100); // Limit to first 100
      res.json({
        routes: routes.map(route => ({
          route: route.route,
          bound: route.bound,
          service_type: route.service_type,
          orig_en: route.orig_en,
          orig_tc: route.orig_tc,
          dest_en: route.dest_en,
          dest_tc: route.dest_tc,
        })),
        count: routes.length,
      });
    } else {
      res.json({ routes: [], count: 0 });
    }
  } catch (error) {
    console.error('Error fetching routes:', error.message);
    res.status(500).json({ error: 'Failed to fetch routes' });
  }
});

/**
 * GET /api/route/:route/:direction
 * Get stops for a specific route and direction
 */
app.get('/api/route/:route/:direction', async (req, res) => {
  try {
    const { route, direction } = req.params;

    const response = await axios.get(
      `${KMB_API_BASE}/route-stop/${route}/${direction}`,
      { timeout: 5000 }
    );

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

/**
 * GET /api/route/:routeNum
 * Get all stops for a route with live ETA data
 */
app.get('/api/route/:routeNum', async (req, res) => {
  try {
    const { routeNum } = req.params;

    // Try to fetch inbound route first (for routes like 91M that go to HKUST)
    // Then fall back to outbound
    let stopsResponse = null;
    let direction = 'I';
    let selectedServiceType = null;

    // Try outbound first with service_type 1 (complete route)
    // For 91M, outbound is PO LAM→DIAMOND HILL (the main direction)
    try {
      stopsResponse = await axios.get(
        `${KMB_API_BASE}/route-stop/${routeNum}/outbound/1`,
        { timeout: 5000 }
      );
      selectedServiceType = '1';
      direction = 'O';
    } catch (e) {
      // If outbound fails, try inbound
      try {
        stopsResponse = await axios.get(
          `${KMB_API_BASE}/route-stop/${routeNum}/inbound/1`,
          { timeout: 5000 }
        );
        direction = 'I';
        selectedServiceType = '1';
      } catch (e2) {
        // If both fail, return empty
        return res.json({
          route: {
            route: routeNum,
            name: 'Route not found',
            name_tc: '路線不存在',
          },
          stops: []
        });
      }
    }

    const routeDetails = await getRouteDetails(routeNum, direction);

    if (!stopsResponse.data || !stopsResponse.data.data) {
      return res.json({
        route: {
          route: routeNum,
          name: routeDetails.name,
          name_tc: routeDetails.name_tc,
        },
        stops: []
      });
    }

    const allStops = stopsResponse.data.data;

    // Get ETA data for each stop from database (latest value only)
    // Calculate wait time in seconds: (eta_timestamp - now)
    const query = `
      SELECT DISTINCT ON (raw.stop)
        raw.stop,
        EXTRACT(EPOCH FROM (raw.eta - NOW()))::integer as wait_sec,
        1 as sample_count,
        raw.fetched_at::timestamp AS window_start,
        (raw.rmk_en ILIKE '%delay%') AS is_delayed
      FROM eta_raw raw
      WHERE raw.route = $1
        AND raw.dir = $2
        AND raw.eta IS NOT NULL
      ORDER BY raw.stop, raw.fetched_at DESC
    `;

    const etaResult = await pool.query(query, [routeNum, direction]);
    const etaMap = {};
    etaResult.rows.forEach(row => {
      etaMap[row.stop] = row;
    });

    // Fetch stop details with limited concurrency (max 5 parallel)
    const stopList = allStops.slice(0, 35);
    const stopsWithDetails = [];
    
    for (let i = 0; i < stopList.length; i += 5) {
      const batch = stopList.slice(i, i + 5);
      const batchResults = await Promise.all(
        batch.map(async (stop) => {
          const stopDetails = await getStopDetails(stop.stop);
          return {
            stop_id: stop.stop,
            sequence: stop.seq,
            name: stopDetails.name_en || `Stop ${stop.seq}`,
            name_en: stopDetails.name_en || '',
            name_tc: stopDetails.name_tc || '',
            lat: stopDetails.lat,
            lng: stopDetails.long,
            wait_sec: etaMap[stop.stop]?.wait_sec,
            sample_count: etaMap[stop.stop]?.sample_count,
            is_delayed: etaMap[stop.stop]?.is_delayed || false,
            window_start: etaMap[stop.stop]?.window_start,
          };
        })
      );
      stopsWithDetails.push(...batchResults);
    }

    // Sort by sequence number (route order)
    const stopsWithETA = stopsWithDetails.sort((a, b) => {
      return parseInt(a.sequence) - parseInt(b.sequence);
    });

    res.json({
      route: {
        route: routeNum,
        name: routeDetails.name,
        name_tc: routeDetails.name_tc,
      },
      stops: stopsWithETA,
      totalStops: allStops.length,
      stopsWithData: stopsWithETA.filter(s => s.wait_sec !== null && s.wait_sec !== undefined).length
    });

    // Broadcast update to WebSocket subscribers
    broadcastRouteUpdate(routeNum, {
      route: {
        route: routeNum,
        name: routeDetails.name,
        name_tc: routeDetails.name_tc,
      },
      stops: stopsWithETA,
      totalStops: allStops.length,
      stopsWithData: stopsWithETA.filter(s => s.wait_sec !== null && s.wait_sec !== undefined).length
    });
  } catch (error) {
    console.error('Error fetching route details:', error.message);
    res.status(500).json({ error: 'Failed to fetch route details' });
  }
});

/**
 * GET /api/route-live/:routeNum
 * Get all stops for a route with REAL-TIME ETA data (direct from KMB API, no caching)
 * This endpoint proxies directly to KMB API for live updates matching the official app
 */
app.get('/api/route-live/:routeNum', async (req, res) => {
  try {
    const { routeNum } = req.params;

    // Try outbound first, then inbound
    let stopsResponse = null;
    let direction = 'O';

    try {
      stopsResponse = await axios.get(
        `${KMB_API_BASE}/route-stop/${routeNum}/outbound/1`,
        { timeout: 5000 }
      );
      direction = 'O';
    } catch (e) {
      try {
        stopsResponse = await axios.get(
          `${KMB_API_BASE}/route-stop/${routeNum}/inbound/1`,
          { timeout: 5000 }
        );
        direction = 'I';
      } catch (e2) {
        return res.json({
          route: {
            route: routeNum,
            name: 'Route not found',
            name_tc: '路線不存在',
          },
          stops: []
        });
      }
    }

    const routeDetails = await getRouteDetails(routeNum, direction);

    if (!stopsResponse.data || !stopsResponse.data.data) {
      return res.json({
        route: {
          route: routeNum,
          name: routeDetails.name,
          name_tc: routeDetails.name_tc,
        },
        stops: []
      });
    }

    const allStops = stopsResponse.data.data;
    const stopList = allStops.slice(0, 35);

    // Fetch LIVE ETA data for each stop directly from KMB API (no database caching)
    const stopsWithLiveETA = await Promise.all(
      stopList.map(async (stop) => {
        try {
          const stopDetails = await getStopDetails(stop.stop);
          
          // Get live ETA from KMB API
          let waitSec = null;
          try {
            const etaResponse = await axios.get(
              `${KMB_API_BASE}/eta/${stop.stop}/${routeNum}/1`,
              { timeout: 5000 }
            );
            
            if (etaResponse.data && etaResponse.data.data && etaResponse.data.data.length > 0) {
              const firstEta = etaResponse.data.data[0];
              const liveETA = firstEta.eta;
              
              // Calculate wait time in seconds from ETA timestamp
              const etaTime = new Date(liveETA);
              const now = new Date();
              waitSec = Math.max(0, Math.round((etaTime - now) / 1000));
            }
          } catch (etaErr) {
            // If ETA fetch fails, waitSec stays null
          }

          return {
            stop_id: stop.stop,
            sequence: stop.seq,
            name: stopDetails.name_en || `Stop ${stop.seq}`,
            name_en: stopDetails.name_en || '',
            name_tc: stopDetails.name_tc || '',
            lat: stopDetails.lat,
            lng: stopDetails.long,
            wait_sec: waitSec,
            is_live: true,
          };
        } catch (err) {
          // Return stop with no ETA if fetch fails
          return {
            stop_id: stop.stop,
            sequence: stop.seq,
            name: `Stop ${stop.seq}`,
            name_en: '',
            name_tc: '',
            lat: null,
            lng: null,
            wait_sec: null,
            is_live: true,
          };
        }
      })
    );

    res.json({
      route: {
        route: routeNum,
        name: routeDetails.name,
        name_tc: routeDetails.name_tc,
      },
      stops: stopsWithLiveETA,
      totalStops: allStops.length,
      stopsWithData: stopsWithLiveETA.filter(s => s.wait_sec !== null && s.wait_sec !== undefined).length,
      timestamp: new Date().toISOString(),
      note: 'Live ETA data - real-time from KMB API, no caching'
    });
  } catch (error) {
    console.error('Error fetching live route details:', error.message);
    res.status(500).json({ error: 'Failed to fetch live route details' });
  }
});

// ============================================================
// ANALYTICS ENDPOINTS (v29)
// ============================================================

/**
 * GET /api/analytics/summary - Daily summary statistics
 */
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const { route = '91M', direction, limit = 10 } = req.query;
    
    let query = `
      SELECT route, direction, analysis_date,
             avg_wait_sec, min_wait_sec, max_wait_sec, p95_wait_sec,
             reliability_pct, on_time_pct, sample_count
      FROM eta_analytics
      WHERE route = $1
    `;
    
    const params = [route];
    
    if (direction) {
      query += ` AND direction = $${params.length + 1}`;
      params.push(direction);
    }
    
    query += ` ORDER BY analysis_date DESC, hour_of_day
      LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) || 10);
    
    const result = await pool.query(query, params);
    res.json({
      route,
      direction: direction || 'all',
      records: result.rows,
      count: result.rows.length,
    });
  } catch (error) {
    console.error('Analytics summary error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analytics/delays - Stops with highest delays
 */
app.get('/api/analytics/delays', async (req, res) => {
  try {
    const { route = '91M', limit = 10, days = 1 } = req.query;
    
    const query = `
      SELECT stop_id, route, direction,
             AVG(p95_wait_sec) as avg_p95,
             AVG(avg_wait_sec) as avg_wait,
             COUNT(*) as occurrences
      FROM eta_analytics
      WHERE route = $1
        AND analysis_date >= NOW() - INTERVAL '${parseInt(days)} days'
        AND p95_wait_sec > 600
      GROUP BY stop_id, route, direction
      ORDER BY avg_p95 DESC
      LIMIT $2
    `;
    
    const result = await pool.query(query, [route, parseInt(limit) || 10]);
    res.json({
      route,
      delayed_stops: result.rows.map(row => ({
        stopId: row.stop_id,
        direction: row.direction,
        p95WaitSeconds: Math.round(row.avg_p95),
        avgWaitSeconds: Math.round(row.avg_wait),
        delayedCount: row.occurrences,
      })),
    });
  } catch (error) {
    console.error('Analytics delays error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analytics/peak-hours - Busiest times by hour
 */
app.get('/api/analytics/peak-hours', async (req, res) => {
  try {
    const { route = '91M', limit = 24 } = req.query;
    
    const query = `
      SELECT hour_of_day, day_of_week,
             ROUND(AVG(avg_wait_sec)::numeric, 1) as avg_wait,
             ROUND(AVG(sample_count)::numeric, 0) as avg_samples,
             COUNT(*) as data_points
      FROM eta_analytics
      WHERE route = $1
      GROUP BY hour_of_day, day_of_week
      ORDER BY avg_wait DESC, hour_of_day
      LIMIT $2
    `;
    
    const result = await pool.query(query, [route, parseInt(limit) || 24]);
    res.json({
      route,
      peak_hours: result.rows.map(row => ({
        hourOfDay: row.hour_of_day,
        dayOfWeek: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][row.day_of_week] || 'Unknown',
        avgWaitSeconds: Math.round(row.avg_wait),
        avgSamples: Math.round(row.avg_samples),
        dataPoints: row.data_points,
      })),
    });
  } catch (error) {
    console.error('Analytics peak hours error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analytics/reliability - Service reliability metrics
 */
app.get('/api/analytics/reliability', async (req, res) => {
  try {
    const { route = '91M', direction } = req.query;
    
    let query = `
      SELECT direction, stop_id,
             ROUND(AVG(on_time_pct)::numeric, 1) as reliability_pct,
             ROUND(AVG(avg_wait_sec)::numeric, 1) as avg_wait,
             COUNT(*) as measurements
      FROM eta_analytics
      WHERE route = $1
    `;
    
    const params = [route];
    
    if (direction) {
      query += ` AND direction = $2`;
      params.push(direction);
    }
    
    query += `
      GROUP BY direction, stop_id
      ORDER BY reliability_pct DESC, stop_id
    `;
    
    const result = await pool.query(query, params);
    res.json({
      route,
      direction: direction || 'all',
      reliability_data: result.rows.map(row => ({
        stopId: row.stop_id,
        direction: row.direction,
        reliabilityPercent: parseFloat(row.reliability_pct),
        avgWaitSeconds: Math.round(row.avg_wait),
        measurements: row.measurements,
      })),
    });
  } catch (error) {
    console.error('Analytics reliability error:', error.message);
    res.status(500).json({ error: error.message });
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

// WebSocket event handlers
io.on('connection', (socket) => {
  console.log(`[WebSocket] Client connected: ${socket.id}`);

  // Subscribe to route updates
  socket.on('subscribe', (routeNum) => {
    if (!routeSubscribers[routeNum]) {
      routeSubscribers[routeNum] = new Set();
    }
    routeSubscribers[routeNum].add(socket.id);
    console.log(`[WebSocket] Client ${socket.id} subscribed to route ${routeNum}`);
    socket.join(`route:${routeNum}`);
    socket.emit('subscribed', { route: routeNum });
  });

  // Unsubscribe from route updates
  socket.on('unsubscribe', (routeNum) => {
    if (routeSubscribers[routeNum]) {
      routeSubscribers[routeNum].delete(socket.id);
    }
    console.log(`[WebSocket] Client ${socket.id} unsubscribed from route ${routeNum}`);
    socket.leave(`route:${routeNum}`);
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log(`[WebSocket] Client disconnected: ${socket.id}`);
    // Clean up subscriptions
    Object.keys(routeSubscribers).forEach(route => {
      routeSubscribers[route].delete(socket.id);
    });
  });
});

// SPA fallback: Serve index.html for all unmatched routes (must be AFTER all API routes)
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(500).json({ error: 'Could not serve index.html' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 HK Bus API Server running on port ${PORT}`);
  console.log(`   Database: ${process.env.DB_HOST || 'postgres-db.hk-bus.svc.cluster.local'}`);
  console.log(`   API: http://localhost:${PORT}/api/health`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n✅ Shutting down gracefully...');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});
