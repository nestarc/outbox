import 'reflect-metadata';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  OnOutboxEvent,
  OutboxAdminService,
  OutboxEmitter,
  OutboxEvent,
  OutboxModule,
  OutboxOperatorService,
  OutboxTenantAdminService,
  type OutboxHandlerContext,
} from '@nestarc/outbox';
import { PrismaClient } from '../generated/client';

class ModernConsumerEvent extends OutboxEvent {
  static readonly eventType = 'modern.consumer.checked';

  constructor(public readonly value: string) {
    super();
  }
}

@Injectable()
class ModernConsumerListener {
  received: Array<{
    payload: Record<string, unknown>;
    context: OutboxHandlerContext;
  }> = [];

  @OnOutboxEvent(ModernConsumerEvent)
  async handle(
    payload: Record<string, unknown>,
    context: OutboxHandlerContext,
  ): Promise<void> {
    this.received.push({ payload, context });
  }
}

function migrationStatements(): string[] {
  const migrationPath =
    require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql');
  return fs
    .readFileSync(migrationPath, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function waitForSent(
  prisma: PrismaClient,
  eventId: string,
): Promise<{ status: string; tenant_id: string | null }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<
      Array<{ status: string; tenant_id: string | null }>
    >`
      SELECT status, tenant_id
      FROM outbox_events
      WHERE id = ${eventId}::uuid
    `;
    if (rows[0]?.status === 'SENT') return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for outbox event ${eventId}`);
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://test:test@localhost:5433/outbox_test';
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  let moduleRef: TestingModule | undefined;

  try {
    await prisma.$connect();
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }
    await prisma.$executeRawUnsafe('TRUNCATE outbox_events');

    moduleRef = await Test.createTestingModule({
      imports: [
        OutboxModule.forRoot({
          prisma,
          polling: { enabled: true, interval: 50, batchSize: 10 },
          retry: { maxRetries: 3, backoff: 'fixed', initialDelay: 50 },
          tenancy: {
            policy: 'require-match',
            provider: { getTenantId: () => 'tenant-modern' },
          },
        }),
      ],
      providers: [ModernConsumerListener],
    }).compile();
    await moduleRef.init();

    const emitter = moduleRef.get(OutboxEmitter);
    const listener = moduleRef.get(ModernConsumerListener);
    const admin = moduleRef.get(OutboxAdminService);
    const operator = moduleRef.get(OutboxOperatorService);
    const tenantAdmin = moduleRef
      .get(OutboxTenantAdminService)
      .forTenant('tenant-modern');
    assert.equal(admin, operator);

    if (false) {
      // @ts-expect-error A tenant scope cannot be overridden per query.
      await tenantAdmin.list({ tenantId: 'tenant-other' });
    }

    await prisma.$transaction(async (tx) => {
      await emitter.emit(tx, new ModernConsumerEvent('prisma-7'), {
        tenantId: 'tenant-modern',
        correlationId: 'ten-m21',
        headers: { source: 'strict-packed-consumer' },
      });
    });

    const pending = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM outbox_events
      WHERE event_type = 'modern.consumer.checked'
    `;
    assert.equal(pending.length, 1);
    const sent = await waitForSent(prisma, pending[0].id);
    assert.equal(sent.tenant_id, 'tenant-modern');
    assert.equal(listener.received.length, 1);
    assert.deepEqual(listener.received[0].payload, { value: 'prisma-7' });
    assert.equal(listener.received[0].context.eventId, pending[0].id);

    const stats = await admin.getStats();
    assert.equal(stats.sent, 1);
    assert.equal(stats.pending, 0);
    const tenantStats = await tenantAdmin.getStats();
    assert.equal(tenantStats.sent, 1);
    assert.equal(tenantStats.pending, 0);

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await emitter.emit(tx, new ModernConsumerEvent('rollback'));
        throw new Error('rollback consumer transaction');
      }),
      /rollback consumer transaction/,
    );
    const rolledBack = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM outbox_events
      WHERE payload ->> 'value' = 'rollback'
    `;
    assert.equal(Number(rolledBack[0].count), 0);

    const prismaVersion = JSON.parse(
      fs.readFileSync(
        `${process.cwd()}/node_modules/@prisma/client/package.json`,
        'utf8',
      ),
    ).version as string;
    const nestVersion = JSON.parse(
      fs.readFileSync(
        `${process.cwd()}/node_modules/@nestjs/core/package.json`,
        'utf8',
      ),
    ).version as string;
    console.log(
      `Outbox packed consumer passed with NestJS ${nestVersion} and Prisma ${prismaVersion}`,
    );
  } finally {
    if (moduleRef) await moduleRef.close();
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS outbox_events');
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
