'use strict';

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  host:     process.env.DB_HOST     || 'postgres-db.hk-bus.svc.cluster.local',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'hkbus',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.post('/', async (req, res) => {
  const start = Date.now();
  try {
    // Ensure analytics table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kmb.analytics (
        route            VARCHAR(20),
        hour_of_day      INTEGER,
        day_of_week      INTEGER,
        avg_wait_minutes NUMERIC(6,2),
        p95_wait_minutes NUMERIC(6,2),
        computed_at      TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (route, hour_of_day, day_of_week)
      )
    `);

    const result = await pool.query(`
      INSERT INTO kmb.analytics
        (route, hour_of_day, day_of_week, avg_wait_minutes, p95_wait_minutes)
      SELECT
        route,
        hour_of_day,
        day_of_week,
        ROUND(AVG(wait_minutes)::numeric, 2),
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY wait_minutes)::numeric, 2)
      FROM kmb.eta
      WHERE fetched_at > (NOW() AT TIME ZONE 'Asia/Hong_Kong') - INTERVAL '2 hours'
        AND wait_minutes IS NOT NULL
      GROUP BY route, hour_of_day, day_of_week
      ON CONFLICT (route, hour_of_day, day_of_week) DO UPDATE
        SET avg_wait_minutes = EXCLUDED.avg_wait_minutes,
            p95_wait_minutes = EXCLUDED.p95_wait_minutes,
            computed_at      = NOW()
    `);

    res.json({ ok: true, rowsAffected: result.rowCount, elapsedMs: Date.now() - start });
  } catch (err) {
    console.error('compute-analytics error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(8080, () => console.log('compute-analytics listening on :8080'));
