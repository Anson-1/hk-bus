#!/usr/bin/env node

/**
 * Real-time ETA Fetcher Service
 * 
 * Continuously fetches real ETA data from KMB API for monitored routes and bus stops,
 * and persists it to PostgreSQL for real-time tracking display.
 */

const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

// Initialize Express app for health checks
const app = express();
const PORT = process.env.PORT || 3002;

// KMB API configuration
const KMB_API_BASE = 'https://data.etabus.gov.hk/v1/transport/kmb';

// Monitored routes - all routes we want to track
const MONITORED_ROUTES = [
  '1', '1A', '2', '3C', '5', '6', '6C', '9', '11', '12', '13D', '15', '26', 
  '40', '42C', '68X', '74B', '91M', '91P', '98D', '270', 'N8'
];

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

// Track API statistics
let stats = {
  totalFetched: 0,
  totalInserted: 0,
  totalErrors: 0,
  lastUpdate: null,
  routeErrors: {},
};

/**
 * Get all stops for a given route
 */
async function getStopsForRoute(routeNum, limit = 20) {
  try {
    // Fetch outbound stops (direction O)
    const response = await axios.get(`${KMB_API_BASE}/route-stop`, {
      params: { route: routeNum, bound: 'O' },
      timeout: 5000
    });

    if (response.data && response.data.data) {
      // Limit to specified number of stops to avoid rate limiting
      // These routes serve many stops across HK, but we sample a few for real-time data
      return response.data.data.slice(0, limit);
    }
  } catch (error) {
    console.warn(`  ⚠ Failed to fetch stops for route ${routeNum}: ${error.message}`);
    if (!stats.routeErrors[routeNum]) {
      stats.routeErrors[routeNum] = 0;
    }
    stats.routeErrors[routeNum]++;
  }

  return [];
}

/**
 * Get ETA data for a specific stop and route
 */
async function getETA(stopId, routeNum, direction = 'O') {
  try {
    const response = await axios.get(
      `${KMB_API_BASE}/eta/${stopId}/${routeNum}`,
      { timeout: 5000 }
    );

    if (response.data && response.data.data && response.data.data.length > 0) {
      return response.data.data; // Return array of ETA objects
    }
  } catch (error) {
    // Silently skip - some routes may not serve all stops
  }

  return [];
}

/**
 * Calculate wait time in seconds from ETA timestamp
 */
function calculateWaitSeconds(etaString) {
  if (!etaString) return 0;

  try {
    const etaTime = new Date(etaString);
    const now = new Date();
    const diff = Math.max(0, (etaTime - now) / 1000);
    return Math.round(diff);
  } catch (e) {
    return 0;
  }
}

/**
 * Insert ETA record into PostgreSQL
 */
async function insertETA(routeNum, direction, stopId, waitSec, delayFlag) {
  try {
    const query = `
      INSERT INTO eta_raw (route, dir, stop_id, wait_sec, delay_flag, fetched_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
      ON CONFLICT DO NOTHING
    `;

    await pool.query(query, [routeNum, direction, stopId, waitSec, delayFlag]);
    stats.totalInserted++;
  } catch (error) {
    console.error(`  ✗ DB Error: ${error.message}`);
    stats.totalErrors++;
  }
}

/**
 * Fetch and persist ETA data for all monitored routes and stops
 */
async function fetchAndPersistETAs() {
  console.log(`\n📡 [${new Date().toISOString()}] Fetching real-time ETA data...`);

  for (const routeNum of MONITORED_ROUTES) {
    try {
      // Get sample stops for this route (first 5 to avoid overwhelming API)
      const stops = await getStopsForRoute(routeNum, 5);
      
      if (stops.length === 0) {
        console.log(`  ⏭️  Route ${routeNum}: no stops available`);
        continue;
      }

      console.log(`  🚌 Route ${routeNum}: sampling ${stops.length} stops`);

      // Fetch ETA data for each stop
      for (let i = 0; i < stops.length; i++) {
        const stopInfo = stops[i];
        const stopId = stopInfo.stop;

        try {
          const etas = await getETA(stopId, routeNum, 'O');
          
          if (etas.length > 0) {
            // Process each ETA entry (usually multiple per stop)
            for (const eta of etas) {
              const waitSec = calculateWaitSeconds(eta.eta);
              const delayFlag = (eta.rmk_en && eta.rmk_en.toLowerCase().includes('delay')) || false;

              await insertETA(routeNum, 'O', stopId, waitSec, delayFlag);
              stats.totalFetched++;
            }
          }
        } catch (error) {
          console.warn(`    ⚠ Error fetching ETA for stop ${stopId}: ${error.message}`);
        }

        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    } catch (error) {
      console.error(`  ✗ Route ${routeNum} error: ${error.message}`);
      stats.totalErrors++;
    }

    // Add delay between routes to avoid overwhelming KMB API
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  stats.lastUpdate = new Date().toISOString();
  console.log(`✅ Fetch cycle complete - Processed: ${stats.totalFetched}, Inserted: ${stats.totalInserted}, Errors: ${stats.totalErrors}`);
}

/**
 * Clean up old data (older than 24 hours)
 */
async function cleanupOldData() {
  try {
    const query = `
      DELETE FROM eta_raw 
      WHERE fetched_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'
    `;

    const result = await pool.query(query);
    console.log(`🧹 Cleanup: Removed ${result.rowCount} stale records older than 24 hours`);
  } catch (error) {
    console.error('❌ Cleanup error:', error.message);
  }
}

/**
 * Main loop - runs fetch cycle repeatedly
 */
async function main() {
  console.log('🚀 HK Bus ETA Fetcher Service Starting');
  console.log(`📍 Monitoring ${MONITORED_ROUTES.length} routes`);
  console.log(`📊 Database: ${process.env.DB_HOST || 'postgres-db.hk-bus.svc.cluster.local'}`);

  // Test database connection
  try {
    const result = await pool.query('SELECT NOW()');
    console.log(`✅ Connected to PostgreSQL: ${result.rows[0].now}`);
  } catch (error) {
    console.error('❌ Failed to connect to PostgreSQL:', error.message);
    process.exit(1);
  }

  // Cleanup on startup
  await cleanupOldData();

  // Poll interval in milliseconds (15 seconds by default)
  const pollInterval = parseInt(process.env.POLL_INTERVAL || '15000', 10);
  console.log(`⏱️  Poll interval: ${pollInterval / 1000} seconds`);

  // Start fetching loop
  let cycleCount = 0;

  const fetchLoop = async () => {
    cycleCount++;
    console.log(`\n═══════════════════════════════════════════════════════════════`);
    console.log(`Cycle #${cycleCount}`);

    try {
      await fetchAndPersistETAs();
    } catch (error) {
      console.error('❌ Fetch cycle failed:', error.message);
    }

    // Run cleanup every 24 cycles (if poll interval is 15s, that's ~6 minutes)
    if (cycleCount % 24 === 0) {
      await cleanupOldData();
    }

    // Schedule next fetch
    setTimeout(fetchLoop, pollInterval);
  };

  // Start the loop
  await fetchLoop();
}

/**
 * Health check endpoint (if needed for monitoring)
 */
function getHealthStatus() {
  return {
    status: 'healthy',
    uptime: process.uptime(),
    stats,
    timestamp: new Date().toISOString(),
  };
}

// Add Express routes for health check
app.get('/health', (req, res) => {
  res.status(200).json(getHealthStatus());
});

app.get('/metrics', (req, res) => {
  res.status(200).json({
    ...getHealthStatus(),
    routeErrors: stats.routeErrors,
  });
});

// Export for testing
module.exports = {
  getHealthStatus,
  getStopsForRoute,
  getETA,
  calculateWaitSeconds,
  insertETA,
};

// Run if executed directly
if (require.main === module) {
  // Start Express server for health checks
  app.listen(PORT, () => {
    console.log(`🏥 Health check server listening on port ${PORT}`);
  });

  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
