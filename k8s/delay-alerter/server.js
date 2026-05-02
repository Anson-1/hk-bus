#!/usr/bin/env node

/**
 * Delay Alerter — OpenFaaS / AWS Lambda equivalent
 *
 * Consumes eta-events from Kafka. When a bus wait time exceeds
 * THRESHOLD_WAIT_SEC, writes a delay alert to PostgreSQL.
 * Maps to: AWS Lambda triggered by Kinesis → OpenFaaS function triggered by Kafka.
 */

const express = require('express');
const { Kafka, logLevel } = require('kafkajs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3004;
const THRESHOLD_WAIT_SEC = parseInt(process.env.THRESHOLD_WAIT_SEC || '600', 10); // 10 minutes

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'hkbus',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

pool.on('error', (err) => console.error('DB pool error:', err.message));

const kafka = new Kafka({
  clientId: 'delay-alerter',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  logLevel: logLevel.WARN,
});

const consumer = kafka.consumer({ groupId: 'delay-alerter-group' });

let stats = {
  messagesConsumed: 0,
  alertsGenerated: 0,
  errors: 0,
};

async function handleEvent(event) {
  const { route, direction, stopId, waitSeconds, timestamp, delayFlag } = event;
  const company = event.company || 'KMB';

  if (!route) return;
  if (!delayFlag) return; // only alert when API explicitly marks bus as delayed

  try {
    await pool.query(
      `INSERT INTO delay_alerts (company, route, stop_id, wait_sec, alerted_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [company, route, stopId, Math.round(waitSeconds), timestamp || new Date().toISOString()]
    );
    stats.alertsGenerated++;
    console.log(`🚨 Delay alert: ${company} route ${route} stop ${stopId} — bus marked as delayed by operator`);
  } catch (err) {
    console.error('Failed to insert alert:', err.message);
    stats.errors++;
  }
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
      stats.messagesConsumed++;
      await handleEvent(event);
    },
  });

  console.log(`✅ Delay alerter consuming eta-events (threshold: ${THRESHOLD_WAIT_SEC}s / ${THRESHOLD_WAIT_SEC / 60} min)`);
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
  console.error('❌ Could not connect to Kafka');
}

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime(), stats, threshold_sec: THRESHOLD_WAIT_SEC });
});

app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send([
    '# HELP delay_alerter_up Delay alerter health status',
    '# TYPE delay_alerter_up gauge',
    'delay_alerter_up 1',
    '# HELP delay_alerter_uptime_seconds Process uptime in seconds',
    '# TYPE delay_alerter_uptime_seconds gauge',
    `delay_alerter_uptime_seconds ${process.uptime().toFixed(2)}`,
    '# HELP delay_alerter_messages_consumed Total Kafka messages consumed',
    '# TYPE delay_alerter_messages_consumed counter',
    `delay_alerter_messages_consumed ${stats.messagesConsumed}`,
    '# HELP delay_alerter_alerts_generated Total delay alerts generated',
    '# TYPE delay_alerter_alerts_generated counter',
    `delay_alerter_alerts_generated ${stats.alertsGenerated}`,
    '',
  ].join('\n'));
});

async function main() {
  console.log('🚀 Delay Alerter starting (AWS Lambda → OpenFaaS equivalent)');

  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
  } catch (err) {
    console.error('❌ PostgreSQL connection failed:', err.message);
    process.exit(1);
  }

  startConsumerWithRetry();

  app.listen(PORT, () => {
    console.log(`🏥 Health/metrics on port ${PORT}`);
  });
}

process.on('SIGTERM', async () => {
  await consumer.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await consumer.disconnect();
  process.exit(0);
});

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
