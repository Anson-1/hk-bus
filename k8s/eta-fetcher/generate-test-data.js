#!/usr/bin/env node

/**
 * Realistic ETA Data Generator for Testing
 * Generates simulated bus arrival times based on realistic patterns
 */

const { Pool } = require('pg');
require('dotenv').config();

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-db.hk-bus.svc.cluster.local',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'hk_bus',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Sample stops for testing - these are real HK bus stops
const TEST_STOPS = [
  '18492910339410B1', // CHUK YUEN ESTATE BUS TERMINUS
  '9ED7E93749ABAE67', // RAINBOW PRIMARY SCHOOL
  '9583BCF159B682BA', // TUNG CHUNG ROAD
  'C9C928E1674AB98',  // KOWLOON CENTRAL POST OFFICE
];

// Monitored routes
const MONITORED_ROUTES = [
  '1', '1A', '2', '3C', '5', '6', '6C', '9', '11', '12', '13D', '15', '26', 
  '40', '42C', '68X', '74B', '91M', '91P', '98D', '270', 'N8'
];

/**
 * Generate realistic wait time based on time of day and route
 */
function generateRealisticWaitTime(route, hour) {
  // Peak hours (8-10, 17-19): shorter waits, more frequent buses
  if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19)) {
    return Math.floor(Math.random() * 8) + 2; // 2-10 min
  }
  // Mid-day (10-17): moderate waits
  if (hour >= 10 && hour < 17) {
    return Math.floor(Math.random() * 12) + 5; // 5-17 min
  }
  // Night (19-23, 0-8): longer waits, less frequent
  return Math.floor(Math.random() * 20) + 10; // 10-30 min
}

/**
 * Generate realistic delay flag (5% chance of delay during off-peak, 10% during peak)
 */
function generateDelayFlag(hour) {
  if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19)) {
    return Math.random() < 0.10; // 10% chance
  }
  return Math.random() < 0.05; // 5% chance
}

/**
 * Insert simulated ETA record
 */
async function insertSimulatedETA(route, direction, stopId, waitSec, delayFlag) {
  try {
    const query = `
      INSERT INTO eta_raw (route, dir, stop_id, wait_sec, delay_flag, fetched_at)
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
    `;

    await pool.query(query, [route, direction, stopId, waitSec, delayFlag]);
    return true;
  } catch (error) {
    console.error(`Error inserting ETA: ${error.message}`);
    return false;
  }
}

/**
 * Generate and insert realistic ETA data
 */
async function generateRealisticData() {
  const now = new Date();
  const hour = now.getHours();

  console.log(`\n📊 Generating realistic ETA data for ${now.toISOString()}`);
  console.log(`⏰ Current hour: ${hour} (${hour < 12 ? 'AM' : 'PM'})`);

  let inserted = 0;
  let failed = 0;

  // For each route
  for (const route of MONITORED_ROUTES) {
    // For each test stop
    for (const stopId of TEST_STOPS) {
      try {
        // Generate 2-4 buses arriving at this stop for this route
        const busCount = Math.floor(Math.random() * 3) + 2;

        for (let busNum = 0; busNum < busCount; busNum++) {
          const waitTime = generateRealisticWaitTime(route, hour);
          const delayFlag = generateDelayFlag(hour);

          const success = await insertSimulatedETA(
            route,
            'O', // outbound direction
            stopId,
            waitTime,
            delayFlag
          );

          if (success) {
            inserted++;
          } else {
            failed++;
          }
        }
      } catch (error) {
        console.error(`Error processing route ${route}: ${error.message}`);
        failed++;
      }
    }
  }

  console.log(`✅ Generated data - Inserted: ${inserted}, Failed: ${failed}`);
  return { inserted, failed };
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Test DB connection
    await pool.query('SELECT NOW()');
    console.log('✅ Connected to PostgreSQL');

    // Generate data
    const result = await generateRealisticData();

    // Close connection
    await pool.end();

    console.log(`\n✨ Done! Total records inserted: ${result.inserted}`);
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
