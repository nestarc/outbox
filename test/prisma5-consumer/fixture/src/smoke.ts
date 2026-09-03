import 'reflect-metadata';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { Injectable, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import {
  OnOutboxEvent,
  OutboxAdminService,
  OutboxEmitter,
  OutboxEvent,
  OutboxModule,
  type OutboxHandler,
  type OutboxHandlerContext,
  type OutboxRecord,
  type OutboxTenantProvider,
  type OutboxTransport,
} from '@nestarc/outbox';

@Injectable()
class RegistrationDependency {
  readonly tenantId = 'tenant-prisma5';
}

@Module({
  providers: [RegistrationDependency],
  exports: [RegistrationDependency],
})
class RegistrationModule {}

@Injectable()
class InjectedTenantProvider implements OutboxTenantProvider {
  constructor(private readonly dependency: RegistrationDependency) {}

  getTenantId(): string {
    return this.dependency.tenantId;
  }
}

@Injectable()
class InjectedTransport implements OutboxTransport {
  constructor(private readonly dependency: RegistrationDependency) {}

  async dispatch(
    record: OutboxRecord,
    handlers: OutboxHandler[],
    context?: OutboxHandlerContext,
  ): Promise<void> {
    assert.equal(this.dependency.tenantId, 'tenant-prisma5');
    assert.ok(context);
    for (const handler of handlers) {
      await handler.instance[handler.methodName](record.payload, context);
    }
  }
}

class Prisma5ConsumerEvent extends OutboxEvent {
  static readonly eventType = 'prisma5.consumer.checked';

  constructor(public readonly value: string) {
    super();
  }
}

@Injectable()
class Prisma5ConsumerListener {
  received: Array<{
    payload: Record<string, unknown>;
    context: OutboxHandlerContext;
  }> = [];

  @OnOutboxEvent(Prisma5ConsumerEvent)
  async handle(
    payload: Record<string, unknown>,
    context: OutboxHandlerContext,
  ): Promise<void> {
    this.received.push({ payload, context });
  }
}

function migrationStatements(): string[] {
  return fs
    .readFileSync(
      require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'),
      'utf8',
    )
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
  const prisma = new PrismaClient();
  let moduleRef: TestingModule | undefined;

  try {
    await prisma.$connect();
    for (const statement of migrationStatements()) {
      await prisma.$executeRawUnsafe(statement);
    }
    await prisma.$executeRawUnsafe('TRUNCATE outbox_events');

    moduleRef = await Test.createTestingModule({
      imports: [
        OutboxModule.forRootAsync({
          imports: [RegistrationModule],
          inject: [RegistrationDependency],
          useFactory: (dependency: RegistrationDependency) => ({
            prisma,
            polling: { enabled: true, interval: 50, batchSize: 10 },
            retry: { maxRetries: 3, backoff: 'fixed', initialDelay: 50 },
            tenancy: {
              policy: dependency.tenantId ? 'required' : 'optional',
            },
          }),
          tenantProvider: InjectedTenantProvider,
          transport: InjectedTransport,
        }),
      ],
      providers: [Prisma5ConsumerListener],
    }).compile();
    await moduleRef.init();

    const emitter = moduleRef.get(OutboxEmitter);
    const listener = moduleRef.get(Prisma5ConsumerListener);
    await prisma.$transaction(async (tx) => {
      await emitter.emit(tx, new Prisma5ConsumerEvent('prisma-5'), {
        correlationId: 'out-m13',
      });
    });

    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM outbox_events
      WHERE event_type = 'prisma5.consumer.checked'
    `;
    assert.equal(rows.length, 1);
    const sent = await waitForSent(prisma, rows[0].id);
    assert.equal(sent.status, 'SENT');
    assert.equal(sent.tenant_id, 'tenant-prisma5');
    assert.equal(listener.received.length, 1);
    assert.deepEqual(listener.received[0].payload, { value: 'prisma-5' });

    const stats = await moduleRef.get(OutboxAdminService).getStats();
    assert.equal(stats.sent, 1);
    const installedPrismaVersion = JSON.parse(
      fs.readFileSync(
        `${process.cwd()}/node_modules/@prisma/client/package.json`,
        'utf8',
      ),
    ).version as string;
    assert.equal(
      installedPrismaVersion,
      process.env.OUTBOX_CONSUMER_PRISMA_VERSION,
    );
    console.log(
      `Outbox packed consumer passed with Prisma ${installedPrismaVersion}`,
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
