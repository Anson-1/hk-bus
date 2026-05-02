'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'host.docker.internal',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'hkbus',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

module.exports = async (event, context) => {
  const start = Date.now();

  try {
    const result = await pool.query(`
      INSERT INTO eta_analytics (route, hour_of_day, day_of_week, avg_wait_sec, p95_wait_sec, computed_at)
      SELECT
        route,
        EXTRACT(HOUR FROM window_start AT TIME ZONE 'Asia/Hong_Kong')::INT AS hour_of_day,
        EXTRACT(DOW  FROM window_start AT TIME ZONE 'Asia/Hong_Kong')::INT AS day_of_week,
        AVG(avg_wait_sec),
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY avg_wait_sec),
        NOW()
      FROM eta_realtime
      WHERE window_start > NOW() - INTERVAL '7 days'
      GROUP BY route, hour_of_day, day_of_week
      ON CONFLICT (route, hour_of_day, day_of_week, computed_at) DO UPDATE
        SET avg_wait_sec = EXCLUDED.avg_wait_sec,
            p95_wait_sec = EXCLUDED.p95_wait_sec
    `);

    const elapsed = Date.now() - start;
    return context
      .status(200)
      .succeed({ ok: true, rowsAffected: result.rowCount, elapsedMs: elapsed });
  } catch (err) {
    console.error('compute-analytics error:', err.message);
    return context.status(500).fail({ ok: false, error: err.message });
  }
};
