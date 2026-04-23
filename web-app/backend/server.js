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

/**
 * Get route details from KMB API (with caching)
 */
async function getRouteDetails(routeNum) {
  if (!routeNum) {
    return { route: routeNum, name: 'Unknown Route', name_tc: '未知路線' };
  }
  
  if (routeCache[routeNum]) {
    return routeCache[routeNum];
  }
  
  try {
    // Use the /route?routes= endpoint which requires the routes parameter
    const response = await axios.get(`${KMB_API_BASE}/route`, {
      params: { routes: routeNum },
      timeout: 3000
    });
    
    if (response.data && response.data.data && response.data.data.length > 0) {
      const route = response.data.data[0];
      routeCache[routeNum] = {
        route: routeNum,
        name: `${route.orig_en} → ${route.dest_en}`,
        name_tc: `${route.orig_tc} → ${route.dest_tc}`,
      };
      console.log(`Fetched route ${routeNum}: ${routeCache[routeNum].name}`);
      return routeCache[routeNum];
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

    // Query PostgreSQL for latest ETA data (all available routes)
    const query = `
      SELECT 
        route,
        dir,
        ROUND(avg_wait_sec::numeric, 0) AS wait_sec,
        sample_count,
        window_start,
        CASE WHEN avg_delay_flag > 0.5 THEN true ELSE false END AS is_delayed
      FROM eta_realtime
      WHERE route IS NOT NULL AND route != ''
      ORDER BY window_start DESC, route ASC
      LIMIT 50
    `;

    const result = await pool.query(query);

    // Enrich ETAs with route details (show all routes)
    const enrichedETAs = await Promise.all(
      result.rows.map(async (row) => {
        const routeDetails = await getRouteDetails(row.route);
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

// ============================================================
// ERROR HANDLING
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
