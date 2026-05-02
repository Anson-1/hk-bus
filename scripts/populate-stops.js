#!/usr/bin/env node
// One-time script to fetch stop names from KMB + CTB APIs and populate the stops table

const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: 'localhost', port: 5432, database: 'hkbus',
  user: 'postgres', password: 'postgres',
});

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  // Get all stop_ids missing names
  const { rows: missing } = await pool.query(`
    SELECT DISTINCT e.stop_id, er.co
    FROM eta_realtime e
    LEFT JOIN stops s ON e.stop_id = s.stop_id
    LEFT JOIN eta_realtime er ON er.stop_id = e.stop_id AND er.co IS NOT NULL
    WHERE s.stop_id IS NULL
  `);

  console.log(`Found ${missing.length} stops missing names`);

  const kmbStops = missing.filter(r => r.co === 'KMB' || !r.co);
  const ctbStops = missing.filter(r => r.co === 'CTB');

  console.log(`KMB: ${kmbStops.length}, CTB: ${ctbStops.length}`);

  let saved = 0;

  // Fetch KMB stop names
  for (const row of kmbStops) {
    try {
      const data = await get(`https://data.etabus.gov.hk/v1/transport/kmb/stop/${row.stop_id}`);
      if (data.data) {
        await pool.query(
          `INSERT INTO stops (stop_id, name_en, name_tc) VALUES ($1, $2, $3)
           ON CONFLICT (stop_id) DO UPDATE SET name_en = $2, name_tc = $3`,
          [row.stop_id, data.data.name_en, data.data.name_tc]
        );
        saved++;
        if (saved % 50 === 0) console.log(`Saved ${saved} stops...`);
      }
    } catch (e) {
      // skip failed
    }
    await new Promise(r => setTimeout(r, 50)); // rate limit
  }

  // Fetch CTB stop names
  for (const row of ctbStops) {
    try {
      const data = await get(`https://rt.data.gov.hk/v2/transport/citybus/stop/${row.stop_id}`);
      if (data.data) {
        await pool.query(
          `INSERT INTO stops (stop_id, name_en, name_tc) VALUES ($1, $2, $3)
           ON CONFLICT (stop_id) DO UPDATE SET name_en = $2, name_tc = $3`,
          [row.stop_id, data.data.name_en, data.data.name_tc]
        );
        saved++;
      }
    } catch (e) {
      // skip failed
    }
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`Done. Total saved: ${saved}`);
  await pool.end();
}

main().catch(console.error);
