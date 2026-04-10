# @nestarc/outbox v0.1.0 — Design Spec

> **Date**: 2026-04-10
> **Status**: Draft
> **Approach**: B (Transport interface from day one)
> **Reference**: `docs/handover.md`

---

## 1. Overview

Prisma-native transactional outbox for NestJS. Solves the dual-write problem by storing events in the same DB transaction as business data, then delivering them asynchronously via polling.

**Positioning**: "Prisma-native transactional outbox for NestJS" — no competitor supports Prisma.

**Key decisions**:
- Prisma `$executeRaw` (schema-independent, no model required in user's schema.prisma)
- `@nestjs/schedule` + `SchedulerRegistry` for dynamic polling interval
- `OutboxTransport` interface for extensibility (MVP: `LocalTransport`)
- All-or-nothing listener strategy (all handlers must succeed for SENT)
- `FOR UPDATE SKIP LOCKED` for multi-instance safety

---

## 2. Architecture

### 2.1 Component Map

```
@nestarc/outbox
├── Public API
│   ├── OutboxModule          — forRoot() / forRootAsync()
│   ├── OutboxEvent           — abstract base class
│   ├── OutboxEmitter         — emit(tx, event) / emitMany(tx, events)
│   └── @OnOutboxEvent()      — listener decorator
│
├── Internal
│   ├── OutboxExplorer        — handler auto-discovery (DiscoveryService)
│   ├── OutboxPoller          — batch fetch + transport dispatch
│   ├── OutboxTransport       — delivery interface
│   └── LocalTransport        — direct handler invocation (MVP)
│
└── Infrastructure
    ├── OutboxRecord          — DB record interface
    ├── OutboxOptions         — module options interface
    └── create-outbox-table.sql
```

### 2.2 Data Flow

```
[User Service]
    │  prisma.$transaction(async (tx) => {
    │    tx.order.create(...)
    │    outboxEmitter.emit(tx, event)
    │  })
    ▼
┌─────────────────────────┐
│  outbox_events table    │  status=PENDING
└────────┬────────────────┘
         │  SchedulerRegistry interval
         ▼
┌─────────────────────────┐
│  OutboxPoller            │
│  ├─ fetchAndLock()       │  SELECT ... FOR UPDATE SKIP LOCKED → PROCESSING
│  ├─ transport.dispatch() │  LocalTransport → handler(payload)
│  ├─ success → SENT       │
│  └─ failure → retry/FAIL │
└─────────────────────────┘
```

### 2.3 Transport Extensibility

```
v0.1: OutboxPoller → LocalTransport    → direct handler invocation
v0.2: OutboxPoller → KafkaTransport    → Kafka publish
                   → ListenNotifyTrans → PG NOTIFY
```

The Poller depends only on the `OutboxTransport` interface. Concrete delivery is swappable without breaking changes.

---

## 3. Public API

### 3.1 Module Registration

```typescript
// Synchronous
OutboxModule.forRoot({
  prisma: PrismaService,
  polling: {
    enabled: true,
    interval: 5000,
    batchSize: 100,
  },
  retry: {
    maxRetries: 5,
    backoff: 'exponential',
    initialDelay: 1000,
  },
  events: [OrderCreatedEvent],
  isGlobal: true,
})

// Async
OutboxModule.forRootAsync({
  imports: [ConfigModule, PrismaModule],
  inject: [ConfigService, PrismaService],
  useFactory: (config, prisma) => ({
    prisma,
    polling: { enabled: true, interval: config.get('OUTBOX_POLL_INTERVAL', 5000), batchSize: 100 },
    retry: { maxRetries: 5, backoff: 'exponential', initialDelay: 1000 },
  }),
})
```

`forRootAsync` supports `useFactory`, `useClass`, `useExisting` — same pattern as `@nestarc/idempotency`.

### 3.2 OutboxOptions Interface

```typescript
interface OutboxOptions {
  /**
   * In forRoot: not used (prisma resolved from DI via prisma field in forRoot params).
   * In forRootAsync: the resolved PrismaService instance returned by the factory.
   * Internally stored as the PrismaService instance after module init.
   */
  prisma: any;
  polling: {
    enabled: boolean;        // default: true
    interval: number;        // ms, default: 5000
    batchSize: number;       // default: 100
  };
  retry: {
    maxRetries: number;      // default: 5
    backoff: 'fixed' | 'exponential';  // default: 'exponential'
    initialDelay: number;    // ms, default: 1000
  };
  events?: Type<OutboxEvent>[];
  isGlobal?: boolean;        // default: true
}
```

**Prisma resolution**:
- `forRoot({ prisma: PrismaService, ... })` — takes a class reference (`Type<any>`). The module creates a provider that injects the PrismaService from DI.
- `forRootAsync({ useFactory: (prisma) => ({ prisma, ... }), inject: [PrismaService] })` — factory receives the already-resolved instance.
```

### 3.3 OutboxEvent Base Class

```typescript
export abstract class OutboxEvent {
  // Subclasses must define: static readonly eventType = 'domain.action';
  // Cannot enforce via abstract static (TS limitation) — validated at runtime.

  toPayload(): Record<string, unknown> {
    // Returns all enumerable own properties except inherited ones
  }

  getEventType(): string {
    // Reads static eventType from constructor, throws if missing
  }
}
```

User defines events as:

```typescript
export class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';
  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) { super(); }
}
```

### 3.4 OutboxEmitter

```typescript
export class OutboxEmitter {
  async emit(tx: PrismaTransactionClient, event: OutboxEvent): Promise<void>;
  async emitMany(tx: PrismaTransactionClient, events: OutboxEvent[]): Promise<void>;
}
```

Both use `$executeRaw` with parameterized queries. `emitMany` uses a single INSERT with multiple value tuples for efficiency.

### 3.5 PrismaTransactionClient Type

Minimal interface independent of Prisma version:

```typescript
export type PrismaTransactionClient = {
  $executeRaw(query: TemplateStringsArray, ...values: any[]): Promise<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: any[]): Promise<T>;
};
```

### 3.6 @OnOutboxEvent Decorator

```typescript
@OnOutboxEvent(OrderCreatedEvent)
async handleOrderCreated(event: OrderCreatedEvent) { ... }

// Multiple event types
@OnOutboxEvent(OrderCreatedEvent, OrderPaidEvent)
async handleOrderEvents(event: OrderCreatedEvent | OrderPaidEvent) { ... }
```

Stores `{ eventTypes: string[] }` metadata via `Reflector`. Explorer builds `eventType → handler[]` map at bootstrap.

### 3.7 Public Exports

```typescript
// Module
export { OutboxModule } from './outbox.module';

// Core
export { OutboxEvent } from './outbox.event';
export { OutboxEmitter } from './outbox.emitter';
export { OnOutboxEvent } from './outbox.decorator';

// Types
export type { OutboxOptions, OutboxAsyncOptions } from './interfaces/outbox-options.interface';
export type { OutboxRecord } from './interfaces/outbox-record.interface';
export type { PrismaTransactionClient } from './interfaces/prisma-transaction-client.interface';
export type { OutboxTransport } from './interfaces/outbox-transport.interface';

// Constants (injection tokens)
export { OUTBOX_OPTIONS, OUTBOX_TRANSPORT } from './outbox.constants';
```

---

## 4. Internal Components

### 4.1 OutboxExplorer

Uses NestJS `DiscoveryService` + `MetadataScanner` to find `@OnOutboxEvent` decorated methods at module init. Builds an internal `Map<string, OutboxHandler[]>`.

```typescript
interface OutboxHandler {
  instance: object;
  methodName: string;
  eventTypes: string[];
}
```

Exposes:
- `getHandlers(eventType: string): OutboxHandler[]`
- `getRegisteredEventTypes(): string[]` (debugging/health)

### 4.2 OutboxTransport Interface

```typescript
export interface OutboxTransport {
  dispatch(record: OutboxRecord, handlers: OutboxHandler[]): Promise<void>;
}
```

### 4.3 LocalTransport (MVP)

Executes handlers **sequentially**. First failure throws immediately (all-or-nothing).

Sequential over parallel because: with all-or-nothing + no idempotency guarantee on handlers, parallel execution risks duplicate side-effects on retry. Sequential makes the failure point deterministic.

### 4.4 OutboxPoller

Registered dynamically via `SchedulerRegistry.addInterval()` in `onModuleInit()` (not `@Interval()` decorator) to support runtime config from `forRootAsync`.

**Poll cycle**:
1. `fetchAndLock(batchSize)` — atomic SELECT + UPDATE to PROCESSING via `FOR UPDATE SKIP LOCKED`
2. For each record: look up handlers, dispatch via transport
3. Success → mark SENT + `processed_at`
4. Failure → increment `retry_count`, record `last_error`
   - Under max → revert to PENDING (backoff delay applied in next fetch query)
   - At max → mark FAILED

**Stuck event recovery**: Every 10th poll cycle, recover events stuck in PROCESSING for > 5 minutes (configurable `stuckThreshold`). Reverts them to PENDING.

**Graceful shutdown** (`OnApplicationShutdown`): Sets `isShuttingDown = true`, waits for `activeCount` to reach 0 (max 30s timeout), then deletes the interval from `SchedulerRegistry`.

---

## 5. SQL Schema

```sql
CREATE TABLE IF NOT EXISTS outbox_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    VARCHAR(255) NOT NULL,
  payload       JSONB NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  retry_count   INT NOT NULL DEFAULT 0,
  max_retries   INT NOT NULL DEFAULT 5,
  last_error    TEXT,
  tenant_id     VARCHAR(255),

  CONSTRAINT chk_status CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (created_at ASC)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_outbox_processing
  ON outbox_events (updated_at ASC)
  WHERE status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS idx_outbox_failed
  ON outbox_events (created_at DESC)
  WHERE status = 'FAILED';
```

`updated_at` is set to NOW() on every status change. Used for backoff calculation (time since last attempt) and stuck event detection.

### Key SQL Queries

**fetchAndLock** (Poller):
```sql
UPDATE outbox_events
SET status = 'PROCESSING', updated_at = NOW()
WHERE id IN (
  SELECT id FROM outbox_events
  WHERE status = 'PENDING'
    AND (
      retry_count = 0
      OR updated_at < NOW() - make_interval(
        secs => CASE
          WHEN $1 = 'exponential'
          THEN $2 / 1000.0 * pow(2, retry_count - 1)
          ELSE $2 / 1000.0
        END
      )
    )
  ORDER BY created_at ASC
  LIMIT $3
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

Backoff is calculated from `updated_at` (last status change), not `created_at` (original creation). This ensures retry delays are measured from the last attempt.

**emit** (Emitter):
```sql
INSERT INTO outbox_events (event_type, payload, max_retries)
VALUES ($1, $2::jsonb, $3);
```

---

## 6. Error Handling

| Scenario | Behavior |
|----------|----------|
| Handler succeeds | status → SENT, processed_at = NOW() |
| Handler throws | retry_count++, last_error recorded, status → PENDING (backoff) |
| Max retries exceeded | status → FAILED, last_error recorded |
| No handlers registered | WARN log, status → SENT (prevent event stuck) |
| Server crash (PROCESSING stuck) | Recovery logic checks `updated_at`, reverts to PENDING after stuckThreshold (default 5min) |
| Transaction rollback | Outbox INSERT also rolled back — no orphan events |

---

## 7. Project Structure

```
@nestarc/outbox/
├── src/
│   ├── index.ts
│   ├── outbox.module.ts
│   ├── outbox.emitter.ts
│   ├── outbox.poller.ts
│   ├── outbox.explorer.ts
│   ├── outbox.event.ts
│   ├── outbox.decorator.ts
│   ├── outbox.constants.ts
│   ├── transports/
│   │   └── local.transport.ts
│   ├── interfaces/
│   │   ├── outbox-options.interface.ts
│   │   ├── outbox-record.interface.ts
│   │   ├── outbox-transport.interface.ts
│   │   └── prisma-transaction-client.interface.ts
│   └── sql/
│       └── create-outbox-table.sql
├── test/
│   ├── outbox.event.spec.ts
│   ├── outbox.emitter.spec.ts
│   ├── outbox.decorator.spec.ts
│   ├── outbox.explorer.spec.ts
│   ├── outbox.poller.spec.ts
│   ├── outbox.module.spec.ts
│   ├── local-transport.spec.ts
│   └── e2e/
│       └── outbox.e2e-spec.ts
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── jest.config.ts
├── .eslintrc.js
├── .prettierrc
├── LICENSE
└── README.md
```

Follows `@nestarc/idempotency` conventions: flat src/, interfaces/ subfolder, Jest projects (unit + e2e).

Added: `transports/` subfolder for transport implementations.

---

## 8. Tech Stack & Dependencies

### Peer Dependencies
- `@nestjs/common` ^10.0.0 || ^11.0.0
- `@nestjs/core` ^10.0.0 || ^11.0.0
- `@nestjs/schedule` ^4.0.0 || ^5.0.0
- `@prisma/client` ^5.0.0 || ^6.0.0
- `reflect-metadata` ^0.1.13 || ^0.2.0

### Dev Dependencies
- `@nestjs/testing`, `@types/jest`, `jest`, `ts-jest`, `typescript` ^5.4
- `prettier`, `eslint`, `rimraf`
- `@prisma/client` (for testing)

### Internal Dependencies
- None (Node.js crypto only for UUID if needed)

### Build
- `tsc -p tsconfig.build.json` (plain tsc, same as idempotency)
- Target: ES2022, module: commonjs

### Engine
- Node.js >= 20.0.0

---

## 9. Testing Strategy

### Unit Tests (`test/*.spec.ts`)

| File | Covers |
|------|--------|
| `outbox.event.spec.ts` | `toPayload()`, `getEventType()`, missing static eventType error |
| `outbox.emitter.spec.ts` | `emit()` $executeRaw call verification, `emitMany()` batch INSERT |
| `outbox.decorator.spec.ts` | Metadata set/read, multiple event types |
| `outbox.explorer.spec.ts` | DiscoveryService mock, handler map construction, unregistered type |
| `outbox.poller.spec.ts` | fetchAndLock query, success/fail/retry flow, graceful shutdown, stuck recovery |
| `outbox.module.spec.ts` | forRoot/forRootAsync registration, option defaults |
| `local-transport.spec.ts` | Sequential execution, first-failure abort, empty handlers |

### E2E Tests (`test/e2e/outbox.e2e-spec.ts`)

Real PostgreSQL + Prisma:
1. emit in transaction → PENDING record in DB
2. Poller runs → handler called → SENT
3. Handler fails → retry_count increments → succeeds on retry
4. Max retries exceeded → FAILED
5. Transaction rollback → no outbox record
6. Two pollers concurrent → SKIP LOCKED (no duplicate processing)

### Coverage Threshold
80% branches/functions/lines/statements (matching idempotency convention).

---

## 10. Out of Scope (v0.2+)

- PostgreSQL LISTEN/NOTIFY transport
- Prisma Client Extensions integration
- @nestarc/tenancy integration (tenant-scoped events)
- Inbox pattern (consumer deduplication)
- External broker adapters (Kafka, RabbitMQ)
- OpenTelemetry tracing middleware
- Dead letter management API
- Metrics (throughput, failure rate, latency)
- Event ordering guarantees (partitioning key)
