#!/usr/bin/env node

/**
 * Delay Alerter — OpenFaaS / AWS Lambda equivalent
 *
 * Consumes ETA events from Redis Stream (replaces Kinesis/Kafka).
 * When rmk_en signals a delay, writes an alert to PostgreSQL.
 * Maps to: AWS Lambda triggered by Kinesis → OpenFaaS triggered by Redis Stream.
 */

const express = require('express');
const { createClient } = require('redis');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3004;
const STREAM_KEY   = process.env.STREAM_KEY   || 'kmb-eta-raw';
const CONSUMER_GRP = process.env.CONSUMER_GRP || 'delay-alerter-group';
const CONSUMER_ID  = process.env.CONSUMER_ID  || 'delay-alerter-1';
const THRESHOLD_MIN = parseInt(process.env.THRESHOLD_MIN || '10', 10); // minutes

const pool = new Pool({
  host:     process.env.DB_HOST     || 'postgres-db.hk-bus.svc.cluster.local',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'hkbus',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
pool.on('error', err => console.error('[DB] pool error:', err.message));

const redis = createClient({ url: process.env.REDIS_URL || 'redis://redis.hk-bus.svc.cluster.local:6379' });
redis.on('error', err => console.error('[Redis] error:', err.message));

const stats = { messagesConsumed: 0, alertsGenerated: 0, errors: 0 };

const DELAY_REMARKS = new Set(['Bus not in service', 'Last Bus']);

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.delay_alerts (
      id         SERIAL PRIMARY KEY,
      company    VARCHAR(10),
      route      VARCHAR(20),
      stop_id    VARCHAR(50),
      wait_min   INTEGER,
      remark     TEXT,
      alerted_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function handleMessage(fields) {
  stats.messagesConsumed++;
  const route  = fields.route  || '';
  const stop   = fields.stop   || '';
  const rmk    = fields.rmk_en || '';
  const eta    = fields.eta    || '';
  const co     = fields.co     || 'KMB';

  // Compute wait minutes from eta timestamp
  let waitMin = null;
  if (eta) {
    const diff = Math.round((new Date(eta) - Date.now()) / 60000);
    if (diff >= 0) waitMin = diff;
  }

  const isDelayed = DELAY_REMARKS.has(rmk) || (waitMin !== null && waitMin > THRESHOLD_MIN);
  if (!isDelayed || !route) return;

  try {
    await pool.query(
      `INSERT INTO public.delay_alerts (company, route, stop_id, wait_min, remark)
       VALUES ($1, $2, $3, $4, $5)`,
      [co, route, stop, waitMin, rmk || null]
    );
    stats.alertsGenerated++;
    console.log(`[alert] ${co} route ${route} stop ${stop} wait=${waitMin}min remark="${rmk}"`);
  } catch (err) {
    console.error('[DB] insert alert failed:', err.message);
    stats.errors++;
  }
}

async function startStreamConsumer() {
  // Create consumer group (ok if already exists)
  try {
    await redis.xGroupCreate(STREAM_KEY, CONSUMER_GRP, '0', { MKSTREAM: true });
    console.log(`[Redis] consumer group "${CONSUMER_GRP}" created`);
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) throw err;
  }

  console.log(`[Redis] consuming stream "${STREAM_KEY}" as "${CONSUMER_ID}"`);

  while (true) {
    try {
      const results = await redis.xReadGroup(
        CONSUMER_GRP, CONSUMER_ID,
        [{ key: STREAM_KEY, id: '>' }],
        { COUNT: 50, BLOCK: 5000 }
      );

      if (!results) continue;

      for (const { messages } of results) {
        for (const { id, message } of messages) {
          await handleMessage(message);
          await redis.xAck(STREAM_KEY, CONSUMER_GRP, id);
        }
      }
    } catch (err) {
      console.error('[Stream] read error:', err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

app.get('/health', (_req, res) =>
  res.json({ status: 'healthy', uptime: process.uptime(), stats, threshold_min: THRESHOLD_MIN })
);

app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send([
    'delay_alerter_up 1',
    `delay_alerter_messages_consumed ${stats.messagesConsumed}`,
    `delay_alerter_alerts_generated ${stats.alertsGenerated}`,
  ].join('\n'));
});

async function main() {
  console.log('🚀 Delay Alerter starting (Kinesis→Lambda replaced by Redis Stream→OpenFaaS)');

  for (let i = 0; i < 10; i++) {
    try { await pool.query('SELECT 1'); console.log('✅ PostgreSQL connected'); break; }
    catch { console.log(`[DB] waiting... (${i+1}/10)`); await new Promise(r => setTimeout(r, 3000)); }
  }

  await ensureSchema();
  await redis.connect();
  console.log('✅ Redis connected');

  app.listen(PORT, () => console.log(`🏥 Health on :${PORT}`));
  startStreamConsumer(); // runs forever in background
}

process.on('SIGTERM', async () => { await redis.quit(); process.exit(0); });
process.on('SIGINT',  async () => { await redis.quit(); process.exit(0); });

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
