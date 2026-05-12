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
    // Delete records older than 1 hour — keeps kmb.eta as a rolling window
    const cleanup = await pool.query(`
      DELETE FROM kmb.eta
      WHERE fetched_at < (NOW() AT TIME ZONE 'Asia/Hong_Kong') - INTERVAL '1 hour'
    `);

    // Keep mtr.eta to 24 hours
    const mtrCleanup = await pool.query(`
      DELETE FROM mtr.eta
      WHERE fetched_at < (NOW() AT TIME ZONE 'Asia/Hong_Kong') - INTERVAL '24 hours'
    `);

    // Keep delay_alerts to 7 days
    const alertCleanup = await pool.query(`
      DELETE FROM public.delay_alerts
      WHERE alerted_at < NOW() - INTERVAL '7 days'
    `);

    res.json({
      ok: true,
      rowsDeleted: cleanup.rowCount,
      mtrRowsDeleted: mtrCleanup.rowCount,
      alertRowsDeleted: alertCleanup.rowCount,
      elapsedMs: Date.now() - start
    });
  } catch (err) {
    console.error('compute-analytics error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(8080, () => console.log('compute-analytics listening on :8080'));
