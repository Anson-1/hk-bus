const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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
        ROUND(AVG(wait_sec)::numeric, 0) AS wait_sec,
        COUNT(*) as sample_count,
        MAX(fetched_at)::timestamp AS window_start,
        CASE WHEN AVG(CASE WHEN delay_flag THEN 1 ELSE 0 END) > 0.5 THEN true ELSE false END AS is_delayed
      FROM eta_raw
      WHERE stop_id = $1
        AND fetched_at > NOW() - INTERVAL '5 minutes'
        AND route IS NOT NULL 
        AND route != ''
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

    // Get ETA data for each stop from database (use most recent 90 seconds for real-time accuracy)
    // Reduced from 2 minutes to 90 seconds now that eta-fetcher only collects next bus
    const query = `
      SELECT DISTINCT
        raw.stop_id,
        ROUND(AVG(raw.wait_sec)::numeric, 0) AS wait_sec,
        COUNT(*) as sample_count,
        MAX(raw.fetched_at)::timestamp AS window_start,
        CASE WHEN AVG(CASE WHEN raw.delay_flag THEN 1 ELSE 0 END) > 0.5 THEN true ELSE false END AS is_delayed
      FROM eta_raw raw
      WHERE raw.route = $1
        AND raw.dir = $2
        AND raw.fetched_at > NOW() - INTERVAL '90 seconds'
      GROUP BY raw.stop_id
    `;

    const etaResult = await pool.query(query, [routeNum, direction]);
    const etaMap = {};
    etaResult.rows.forEach(row => {
      etaMap[row.stop_id] = row;
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
  } catch (error) {
    console.error('Error fetching route details:', error.message);
    res.status(500).json({ error: 'Failed to fetch route details' });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 HK Bus API Server running on port ${PORT}`);
  console.log(`   Database: ${process.env.DB_HOST || 'postgres-db.hk-bus.svc.cluster.local'}`);
  console.log(`   API: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n✅ Shutting down gracefully...');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});
