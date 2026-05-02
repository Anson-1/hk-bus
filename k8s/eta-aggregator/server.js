#!/usr/bin/env node

const express = require('express');
const { Pool } = require('pg');
const { Kafka, logLevel } = require('kafkajs');

const app = express();
const PORT = process.env.PORT || 3003;
const FLUSH_INTERVAL_MS = parseInt(process.env.FLUSH_INTERVAL_MS || '60000', 10);

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-db.hk-bus.svc.cluster.local',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'hkbus',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

pool.on('error', (err) => console.error('DB pool error:', err.message));

const kafka = new Kafka({
  clientId: 'eta-aggregator',
  brokers: (process.env.KAFKA_BROKERS || 'kafka-broker.hk-bus.svc.cluster.local:9092').split(','),
  logLevel: logLevel.WARN,
});

const consumer = kafka.consumer({ groupId: 'eta-aggregator-group' });

// In-memory buffer: key = "route:dir:stopId"
// value = { sum, count, windowStart }
const buffer = new Map();

let stats = {
  messagesConsumed: 0,
  flushCount: 0,
  rowsWritten: 0,
  errors: 0,
  lastFlush: null,
};

function getWindowStart() {
  const now = new Date();
  now.setSeconds(0, 0);
  return now.toISOString();
}

function bufferEvent(route, direction, stopId, waitSeconds, company) {
  const key = `${route}:${direction}:${stopId}`;
  const windowStart = getWindowStart();

  const existing = buffer.get(key);

  if (existing && existing.windowStart === windowStart) {
    existing.sum += waitSeconds;
    existing.count += 1;
  } else {
    buffer.set(key, { sum: waitSeconds, count: 1, windowStart, route, direction, stopId, company });
  }
}

async function flushBuffer() {
  if (buffer.size === 0) return;

  const snapshot = new Map(buffer);
  buffer.clear();

  const windowStart = getWindowStart();
  let written = 0;

  for (const entry of snapshot.values()) {
    const avgWaitSec = entry.sum / entry.count;

    try {
      await pool.query(
        `INSERT INTO eta_realtime (route, dir, stop_id, window_start, avg_wait_sec, sample_count, co)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (route, dir, stop_id, window_start)
         DO UPDATE SET avg_wait_sec = $5, sample_count = $6, co = $7`,
        [entry.route, entry.direction, entry.stopId, entry.windowStart, avgWaitSec, entry.count, entry.company || null]
      );
      written++;
    } catch (err) {
      console.error(`DB upsert error (${entry.route}/${entry.direction}/${entry.stopId}):`, err.message);
      stats.errors++;
    }
  }

  stats.flushCount++;
  stats.rowsWritten += written;
  stats.lastFlush = new Date().toISOString();
  console.log(`💾 Flushed window ${windowStart} — ${written} stop rows written`);
}

async function startConsumer() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'eta-events', fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch {
        return;
      }

      const { route, direction, stopId, waitSeconds, company } = event;
      if (!route || !direction || !stopId || waitSeconds == null) return;

      bufferEvent(route, direction, stopId, waitSeconds, company);
      stats.messagesConsumed++;
    },
  });

  console.log('✅ Kafka consumer running on topic eta-events');
}

async function startConsumerWithRetry(maxAttempts = 20, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await startConsumer();
      return;
    } catch (err) {
      console.warn(`⚠ Kafka connect attempt ${attempt}/${maxAttempts}: ${err.message}`);
      if (attempt < maxAttempts) {
        try { await consumer.disconnect(); } catch {}
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  console.error('❌ Kafka consumer could not start — running without streaming');
}

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime(), bufferSize: buffer.size, stats });
});

app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send([
    '# HELP eta_aggregator_up ETA aggregator health status',
    '# TYPE eta_aggregator_up gauge',
    'eta_aggregator_up 1',
    '# HELP eta_aggregator_uptime_seconds Process uptime in seconds',
    '# TYPE eta_aggregator_uptime_seconds gauge',
    `eta_aggregator_uptime_seconds ${process.uptime().toFixed(2)}`,
    '# HELP eta_aggregator_messages_consumed Total Kafka messages consumed',
    '# TYPE eta_aggregator_messages_consumed counter',
    `eta_aggregator_messages_consumed ${stats.messagesConsumed}`,
    '# HELP eta_aggregator_rows_written Total rows written to eta_realtime',
    '# TYPE eta_aggregator_rows_written counter',
    `eta_aggregator_rows_written ${stats.rowsWritten}`,
    '# HELP eta_aggregator_flush_count Total flush cycles completed',
    '# TYPE eta_aggregator_flush_count counter',
    `eta_aggregator_flush_count ${stats.flushCount}`,
    '',
  ].join('\n'));
});

// Latest avg wait per stop for a given route+direction
app.get('/realtime', async (req, res) => {
  const { route, dir } = req.query;
  if (!route || !dir) return res.status(400).json({ error: 'route and dir are required' });

  try {
    // Return most recent window row per stop
    const result = await pool.query(
      `SELECT DISTINCT ON (stop_id)
         stop_id, avg_wait_sec, sample_count, window_start
       FROM eta_realtime
       WHERE route = $1 AND dir = $2
       ORDER BY stop_id, window_start DESC`,
      [route, dir]
    );
    res.json({ route, dir, stops: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Historical avg wait per stop over last N hours
app.get('/history', async (req, res) => {
  const { route, dir, stop_id, hours = 1 } = req.query;
  if (!route || !dir || !stop_id) {
    return res.status(400).json({ error: 'route, dir, stop_id are required' });
  }

  try {
    const result = await pool.query(
      `SELECT window_start, avg_wait_sec, sample_count
       FROM eta_realtime
       WHERE route = $1 AND dir = $2 AND stop_id = $3
         AND window_start > NOW() - ($4 || ' hours')::INTERVAL
       ORDER BY window_start ASC`,
      [route, dir, stop_id, parseInt(hours, 10)]
    );
    res.json({ route, dir, stop_id, history: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function main() {
  console.log('🚀 ETA Aggregator Service starting');
  console.log(`⏱  Flush interval: ${FLUSH_INTERVAL_MS / 1000}s`);

  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    process.exit(1);
  }

  startConsumerWithRetry();

  // Flush buffer to DB every minute
  setInterval(flushBuffer, FLUSH_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`🏥 HTTP server listening on port ${PORT}`);
  });
}

process.on('SIGTERM', async () => {
  console.log('⏹ Flushing buffer before shutdown...');
  await flushBuffer();
  await consumer.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await flushBuffer();
  await consumer.disconnect();
  process.exit(0);
});

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
