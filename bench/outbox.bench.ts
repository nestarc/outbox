/**
 * Outbox benchmark — measures emit overhead and poll-to-dispatch latency.
 *
 * Scenarios:
 *   A) INSERT — no outbox (baseline)
 *   B) emit() — single event in transaction
 *   C) emitMany() — 10 events in transaction
 *   D) Poll-to-dispatch — end-to-end latency (PENDING → handler called)
 *   E) Poller throughput — 100 events batch processing
 *
 * Usage:
 *   docker compose up -d
 *   DATABASE_URL=postgresql://test:test@localhost:5433/outbox_test \
 *     npx ts-node bench/outbox.bench.ts
 *   DATABASE_URL=... npx ts-node bench/outbox.bench.ts --iterations 500
 */
import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import {
  Injectable,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';

import { OutboxModule } from '../src/outbox.module';
import { OutboxEmitter } from '../src/outbox.emitter';
import { OutboxEvent } from '../src/outbox.event';
import { OutboxPoller } from '../src/outbox.poller';
import { OnOutboxEvent } from '../src/outbox.decorator';

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const ITERATIONS = Number(flag('iterations', '200'));
const WARMUP = Number(flag('warmup', '20'));

// ── Test event ────────────────────────────────────────────────────────
class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';
  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}

// ── Prisma service ────────────────────────────────────────────────────
@Injectable()
class PrismaService extends PrismaClient {
  constructor() {
    super({
      datasources: {
        db: {
          url:
            process.env.DATABASE_URL ??
            'postgresql://test:test@localhost:5433/outbox_test',
        },
      },
    });
  }
}

// ── Listener for latency measurement ──────────────────────────────────
@Injectable()
class BenchListener {
  onEvent: ((timestamp: number) => void) | null = null;

  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated() {
    this.onEvent?.(performance.now());
  }
}

// ── Stats ─────────────────────────────────────────────────────────────
interface Stats {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
  };
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function printStats(label: string, stats: Stats): void {
  console.log(
    `  ${label.padEnd(48)} Avg ${fmt(stats.avg).padStart(8)}  P50 ${fmt(stats.p50).padStart(8)}  P95 ${fmt(stats.p95).padStart(8)}  P99 ${fmt(stats.p99).padStart(8)}`,
  );
}

// ── Runner ────────────────────────────────────────────────────────────
async function measure(
  label: string,
  fn: (i: number) => Promise<void>,
): Promise<Stats> {
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await fn(ITERATIONS + i);
  }

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await fn(i);
    samples.push(performance.now() - start);
  }

  const stats = computeStats(samples);
  printStats(label, stats);
  return stats;
}

// ── Setup ─────────────────────────────────────────────────────────────
const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '../src/sql/create-outbox-table.sql'),
  'utf-8',
);

const MIGRATION_STATEMENTS = MIGRATION_SQL
  .split(';')
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith('--'));

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE outbox_events');
}

// ── Main ──────────────────────────────────────────────────────────────
async function run() {
  console.log(`\nOutbox Benchmark`);
  console.log(`  iterations: ${ITERATIONS}, warmup: ${WARMUP}\n`);

  const prisma = new PrismaService();
  await prisma.$connect();

  for (const stmt of MIGRATION_STATEMENTS) {
    await prisma.$executeRawUnsafe(stmt);
  }

  // ── A) Baseline ────────────────────────────────────────────────
  await cleanup(prisma);
  const baselineStats = await measure(
    'A) INSERT — no outbox (baseline)',
    async (i) => {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO outbox_events (event_type, payload, max_retries)
          VALUES (${'bench.baseline'}, ${JSON.stringify({ i })}::jsonb, ${5})
        `;
      });
    },
  );
  await cleanup(prisma);

  // ── B) emit() ──────────────────────────────────────────────────
  @Module({
    imports: [
      OutboxModule.forRoot({
        prisma,
        polling: { enabled: false },
        retry: { maxRetries: 5, backoff: 'exponential', initialDelay: 1000 },
      }),
    ],
  })
  class EmitModule {}

  const emitRef = await Test.createTestingModule({
    imports: [EmitModule],
  }).compile();
  const emitApp = emitRef.createNestApplication();
  await emitApp.init();
  const emitter = emitRef.get(OutboxEmitter);

  const emitStats = await measure(
    'B) emit() — single event in transaction',
    async (i) => {
      await prisma.$transaction(async (tx: any) => {
        await emitter.emit(tx, new OrderCreatedEvent(`order-${i}`, 99.99));
      });
    },
  );
  await cleanup(prisma);

  // ── C) emitMany() ──────────────────────────────────────────────
  const emitManyStats = await measure(
    'C) emitMany() — 10 events in transaction',
    async (i) => {
      const events = Array.from(
        { length: 10 },
        (_, j) => new OrderCreatedEvent(`order-${i}-${j}`, 10 + j),
      );
      await prisma.$transaction(async (tx: any) => {
        await emitter.emitMany(tx, events);
      });
    },
  );
  await cleanup(prisma);
  await emitApp.close();

  // ── D) Poll-to-dispatch ────────────────────────────────────────
  @Module({
    imports: [
      OutboxModule.forRoot({
        prisma,
        polling: { enabled: false, batchSize: 100 },
        retry: { maxRetries: 5, backoff: 'exponential', initialDelay: 1000 },
      }),
    ],
    providers: [BenchListener],
  })
  class PollModule {}

  const pollRef = await Test.createTestingModule({
    imports: [PollModule],
  }).compile();
  const pollApp = pollRef.createNestApplication();
  await pollApp.init();

  const pollEmitter = pollRef.get(OutboxEmitter);
  const poller = pollRef.get(OutboxPoller);
  const listener = pollRef.get(BenchListener);

  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await prisma.$transaction(async (tx: any) => {
      await pollEmitter.emit(tx, new OrderCreatedEvent(`wu-${i}`, 1));
    });
    await poller.poll();
  }
  await cleanup(prisma);

  // Measure
  const dispatchSamples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    await prisma.$transaction(async (tx: any) => {
      await pollEmitter.emit(tx, new OrderCreatedEvent(`d-${i}`, 99.99));
    });

    const dispatchPromise = new Promise<number>((resolve) => {
      listener.onEvent = (ts) => resolve(ts);
    });

    const pollStart = performance.now();
    await poller.poll();
    const handlerTs = await dispatchPromise;
    dispatchSamples.push(handlerTs - pollStart);
    listener.onEvent = null;
  }
  const dispatchStats = computeStats(dispatchSamples);
  printStats('D) Poll-to-dispatch — single event latency', dispatchStats);
  await cleanup(prisma);

  // ── E) Poller throughput ───────────────────────────────────────
  const batchSize = 100;
  const throughputIter = Math.min(ITERATIONS, 20);

  // Warmup
  for (let w = 0; w < Math.min(WARMUP, 3); w++) {
    for (let j = 0; j < batchSize; j++) {
      await prisma.$transaction(async (tx: any) => {
        await pollEmitter.emit(tx, new OrderCreatedEvent(`tw-${w}-${j}`, 1));
      });
    }
    await poller.poll();
    await cleanup(prisma);
  }

  const throughputSamples: number[] = [];
  for (let i = 0; i < throughputIter; i++) {
    for (let j = 0; j < batchSize; j++) {
      await prisma.$transaction(async (tx: any) => {
        await pollEmitter.emit(tx, new OrderCreatedEvent(`t-${i}-${j}`, 10));
      });
    }
    const start = performance.now();
    await poller.poll();
    throughputSamples.push(performance.now() - start);
    await cleanup(prisma);
  }
  const throughputStats = computeStats(throughputSamples);
  printStats(`E) Poller throughput — ${batchSize} events batch`, throughputStats);

  // ── Summary ────────────────────────────────────────────────────
  const emitOverhead = emitStats.avg - baselineStats.avg;
  console.log('\n  Summary');
  console.log(`  ──────────────────────────────────────────────────────`);
  console.log(`  Emit overhead (B − A):                           ~${fmt(emitOverhead)}`);
  console.log(`  emitMany(10) per-event cost:                     ~${fmt(emitManyStats.avg / 10)}`);
  console.log(`  Poll-to-dispatch (single event):                 ~${fmt(dispatchStats.avg)}`);
  console.log(`  Poller throughput (${batchSize} events):                  ~${fmt(throughputStats.avg)} (${(batchSize / (throughputStats.avg / 1000)).toFixed(0)} events/sec)`);

  await pollApp.close();
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS outbox_events');
  await prisma.$disconnect();

  console.log('\nDone.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
