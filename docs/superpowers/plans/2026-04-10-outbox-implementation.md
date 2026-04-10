# @nestarc/outbox v0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Prisma-native transactional outbox library for NestJS with polling delivery, retry with backoff, and a transport interface for future extensibility.

**Architecture:** Events are stored in the same DB transaction via `OutboxEmitter.emit(tx, event)` using Prisma `$executeRaw`. An `OutboxPoller` periodically fetches PENDING events with `FOR UPDATE SKIP LOCKED` and dispatches them through an `OutboxTransport` interface. MVP ships `LocalTransport` (direct handler invocation). Handlers are discovered via `@OnOutboxEvent()` decorator + NestJS `DiscoveryService`.

**Tech Stack:** NestJS 10/11, Prisma (raw queries), PostgreSQL, `@nestjs/schedule`, TypeScript 5.4+, Jest

**Spec:** `docs/superpowers/specs/2026-04-10-outbox-design.md`
**Conventions:** Follow `@nestarc/idempotency` patterns (at `/Users/ksy/Documents/GitHub/idempotency/`)

---

## File Structure

```
src/
├── index.ts                                    # Public API exports
├── outbox.module.ts                            # DynamicModule (forRoot / forRootAsync)
├── outbox.emitter.ts                           # emit(tx, event) / emitMany(tx, events)
├── outbox.poller.ts                            # Polling loop + retry + graceful shutdown
├── outbox.explorer.ts                          # @OnOutboxEvent handler discovery
├── outbox.event.ts                             # Abstract base class
├── outbox.decorator.ts                         # @OnOutboxEvent() decorator
├── outbox.constants.ts                         # Injection tokens + defaults
├── transports/
│   └── local.transport.ts                      # Direct handler invocation
├── interfaces/
│   ├── outbox-options.interface.ts             # Module options
│   ├── outbox-record.interface.ts              # DB record shape
│   ├── outbox-transport.interface.ts           # Transport contract
│   ├── outbox-handler.interface.ts             # Handler descriptor
│   └── prisma-transaction-client.interface.ts  # Minimal Prisma tx type
└── sql/
    └── create-outbox-table.sql                 # Migration SQL

test/
├── outbox.event.spec.ts
├── outbox.decorator.spec.ts
├── outbox.emitter.spec.ts
├── outbox.explorer.spec.ts
├── outbox.poller.spec.ts
├── outbox.module.spec.ts
├── local-transport.spec.ts
└── e2e/
    ├── prisma/
    │   └── schema.prisma                       # Minimal datasource-only schema
    └── outbox.e2e-spec.ts
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `jest.config.ts`
- Create: `.prettierrc`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@nestarc/outbox",
  "version": "0.1.0",
  "description": "Prisma-native transactional outbox for NestJS — atomic event emission, polling with SKIP LOCKED, retry with backoff, @OnOutboxEvent() decorator.",
  "license": "MIT",
  "author": "nestarc",
  "homepage": "https://nestarc.dev",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/nestarc/outbox.git"
  },
  "bugs": {
    "url": "https://github.com/nestarc/outbox/issues"
  },
  "keywords": [
    "nestjs",
    "outbox",
    "outbox-pattern",
    "transactional-outbox",
    "prisma",
    "event",
    "dual-write",
    "polling",
    "nestarc"
  ],
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": [
    "dist",
    "src/sql",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "clean": "rimraf dist coverage",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "lint": "eslint \"src/**/*.ts\" \"test/**/*.ts\"",
    "test": "jest --selectProjects unit",
    "test:watch": "jest --selectProjects unit --watch",
    "test:cov": "jest --selectProjects unit --coverage",
    "test:e2e": "jest --selectProjects e2e --runInBand",
    "test:all": "jest",
    "prisma:generate": "prisma generate --schema test/e2e/prisma/schema.prisma",
    "prepublishOnly": "npm run clean && npm run lint && npm run test && npm run build"
  },
  "peerDependencies": {
    "@nestjs/common": "^10.0.0 || ^11.0.0",
    "@nestjs/core": "^10.0.0 || ^11.0.0",
    "@nestjs/schedule": "^4.0.0 || ^5.0.0",
    "@prisma/client": "^5.0.0 || ^6.0.0",
    "reflect-metadata": "^0.1.13 || ^0.2.0"
  },
  "devDependencies": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "@nestjs/schedule": "^5.0.0",
    "@nestjs/testing": "^11.0.0",
    "@prisma/client": "^6.0.0",
    "@types/jest": "^29.5.12",
    "@types/node": "^20.11.0",
    "@typescript-eslint/eslint-plugin": "^7.18.0",
    "@typescript-eslint/parser": "^7.18.0",
    "eslint": "^8.57.0",
    "eslint-config-prettier": "^9.1.0",
    "jest": "^29.7.0",
    "prettier": "^3.3.0",
    "prisma": "^6.0.0",
    "reflect-metadata": "^0.2.2",
    "rimraf": "^5.0.10",
    "rxjs": "^7.8.1",
    "ts-jest": "^29.2.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.4.5"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "moduleResolution": "node",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictBindCallApply": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "outDir": "./dist",
    "incremental": true,
    "types": ["node", "jest"]
  },
  "include": ["src/**/*", "test/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create tsconfig.build.json**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"],
    "declaration": true,
    "noEmit": false,
    "removeComments": false,
    "incremental": false
  },
  "include": ["src/**/*"],
  "exclude": [
    "node_modules",
    "dist",
    "test",
    "**/*.spec.ts",
    "**/*.e2e-spec.ts",
    "jest.config.ts"
  ]
}
```

- [ ] **Step 4: Create jest.config.ts**

```typescript
import type { Config } from 'jest';

const tsJestTransform: Config['transform'] = {
  '^.+\\.ts$': [
    'ts-jest',
    {
      tsconfig: 'tsconfig.json',
    },
  ],
};

const config: Config = {
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/**/index.ts',
    '!src/**/*.interface.ts',
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      moduleFileExtensions: ['ts', 'js', 'json'],
      transform: tsJestTransform,
      clearMocks: true,
      restoreMocks: true,
      testMatch: ['<rootDir>/test/**/*.spec.ts'],
      testPathIgnorePatterns: ['<rootDir>/test/e2e/'],
    },
    {
      displayName: 'e2e',
      preset: 'ts-jest',
      testEnvironment: 'node',
      moduleFileExtensions: ['ts', 'js', 'json'],
      transform: tsJestTransform,
      clearMocks: true,
      restoreMocks: true,
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
    },
  ],
};

export default config;
```

- [ ] **Step 5: Create .prettierrc**

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 80,
  "tabWidth": 2,
  "semi": true
}
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 7: Verify build tooling**

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet, should pass cleanly).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json jest.config.ts .prettierrc
git commit -m "chore: scaffold project with build, test, and lint tooling"
```

---

## Task 2: Foundation — Constants, Interfaces, SQL

**Files:**
- Create: `src/outbox.constants.ts`
- Create: `src/interfaces/outbox-options.interface.ts`
- Create: `src/interfaces/outbox-record.interface.ts`
- Create: `src/interfaces/outbox-transport.interface.ts`
- Create: `src/interfaces/outbox-handler.interface.ts`
- Create: `src/interfaces/prisma-transaction-client.interface.ts`
- Create: `src/sql/create-outbox-table.sql`

No tests — these are pure types, constants, and SQL.

- [ ] **Step 1: Create outbox.constants.ts**

```typescript
export const OUTBOX_OPTIONS = Symbol('OUTBOX_OPTIONS');
export const OUTBOX_TRANSPORT = Symbol('OUTBOX_TRANSPORT');
export const OUTBOX_EVENT_METADATA = Symbol('OUTBOX_EVENT_METADATA');

export const DEFAULT_POLLING_INTERVAL = 5000;
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_BACKOFF: 'fixed' | 'exponential' = 'exponential';
export const DEFAULT_INITIAL_DELAY = 1000;
export const DEFAULT_STUCK_THRESHOLD = 300_000; // 5 minutes in ms
export const DEFAULT_SHUTDOWN_TIMEOUT = 30_000; // 30 seconds in ms
export const STUCK_RECOVERY_INTERVAL = 10; // every Nth poll cycle
```

- [ ] **Step 2: Create interface files**

`src/interfaces/prisma-transaction-client.interface.ts`:
```typescript
export type PrismaTransactionClient = {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};
```

`src/interfaces/outbox-handler.interface.ts`:
```typescript
export interface OutboxHandler {
  instance: Record<string, any>;
  methodName: string;
  eventTypes: string[];
}
```

`src/interfaces/outbox-record.interface.ts`:
```typescript
export interface OutboxRecord {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  tenantId: string | null;
}
```

`src/interfaces/outbox-transport.interface.ts`:
```typescript
import type { OutboxHandler } from './outbox-handler.interface';
import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxTransport {
  dispatch(record: OutboxRecord, handlers: OutboxHandler[]): Promise<void>;
}
```

`src/interfaces/outbox-options.interface.ts`:
```typescript
import type { ModuleMetadata, Type } from '@nestjs/common';

export interface OutboxPollingOptions {
  enabled?: boolean;
  interval?: number;
  batchSize?: number;
}

export interface OutboxRetryOptions {
  maxRetries?: number;
  backoff?: 'fixed' | 'exponential';
  initialDelay?: number;
}

export interface OutboxOptions {
  prisma: any;
  polling?: OutboxPollingOptions;
  retry?: OutboxRetryOptions;
  events?: Type[];
  isGlobal?: boolean;
  stuckThreshold?: number;
}

export interface OutboxAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  inject?: any[];
  useFactory?: (...args: any[]) => OutboxOptions | Promise<OutboxOptions>;
  useClass?: Type<OutboxOptionsFactory>;
  useExisting?: Type<OutboxOptionsFactory>;
  isGlobal?: boolean;
}

export interface OutboxOptionsFactory {
  createOutboxOptions(): OutboxOptions | Promise<OutboxOptions>;
}
```

- [ ] **Step 3: Create SQL migration file**

`src/sql/create-outbox-table.sql`:
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

-- PENDING events: polled frequently, ordered by creation time
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox_events (created_at ASC)
  WHERE status = 'PENDING';

-- PROCESSING events: stuck event recovery checks updated_at
CREATE INDEX IF NOT EXISTS idx_outbox_processing
  ON outbox_events (updated_at ASC)
  WHERE status = 'PROCESSING';

-- FAILED events: admin/monitoring queries
CREATE INDEX IF NOT EXISTS idx_outbox_failed
  ON outbox_events (created_at DESC)
  WHERE status = 'FAILED';
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/outbox.constants.ts src/interfaces/ src/sql/
git commit -m "feat: add constants, interfaces, and SQL migration"
```

---

## Task 3: OutboxEvent Base Class (TDD)

**Files:**
- Create: `test/outbox.event.spec.ts`
- Create: `src/outbox.event.ts`

- [ ] **Step 1: Write the failing tests**

`test/outbox.event.spec.ts`:
```typescript
import { OutboxEvent } from '../src/outbox.event';

class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';

  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}

class MissingEventTypeEvent extends OutboxEvent {}

describe('OutboxEvent', () => {
  describe('getEventType', () => {
    it('should return the static eventType from the subclass', () => {
      const event = new OrderCreatedEvent('order-1', 100);
      expect(event.getEventType()).toBe('order.created');
    });

    it('should throw if static eventType is not defined', () => {
      const event = new MissingEventTypeEvent();
      expect(() => event.getEventType()).toThrow(
        'MissingEventTypeEvent must define static readonly eventType',
      );
    });
  });

  describe('toPayload', () => {
    it('should return all own enumerable properties', () => {
      const event = new OrderCreatedEvent('order-1', 100);
      expect(event.toPayload()).toEqual({
        orderId: 'order-1',
        total: 100,
      });
    });

    it('should return empty object for event with no properties', () => {
      class EmptyEvent extends OutboxEvent {
        static readonly eventType = 'empty';
      }
      const event = new EmptyEvent();
      expect(event.toPayload()).toEqual({});
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --selectProjects unit -- test/outbox.event.spec.ts`
Expected: FAIL — `Cannot find module '../src/outbox.event'`

- [ ] **Step 3: Implement OutboxEvent**

`src/outbox.event.ts`:
```typescript
export abstract class OutboxEvent {
  toPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this)) {
      payload[key] = value;
    }
    return payload;
  }

  getEventType(): string {
    const ctor = this.constructor as typeof OutboxEvent & {
      eventType?: string;
    };
    if (!ctor.eventType || typeof ctor.eventType !== 'string') {
      throw new Error(
        `${ctor.name} must define static readonly eventType: string`,
      );
    }
    return ctor.eventType;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --selectProjects unit -- test/outbox.event.spec.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/outbox.event.ts test/outbox.event.spec.ts
git commit -m "feat: add OutboxEvent abstract base class"
```

---

## Task 4: @OnOutboxEvent Decorator (TDD)

**Files:**
- Create: `test/outbox.decorator.spec.ts`
- Create: `src/outbox.decorator.ts`

- [ ] **Step 1: Write the failing tests**

`test/outbox.decorator.spec.ts`:
```typescript
import { OUTBOX_EVENT_METADATA } from '../src/outbox.constants';
import { OnOutboxEvent } from '../src/outbox.decorator';
import { OutboxEvent } from '../src/outbox.event';

class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';
}

class OrderPaidEvent extends OutboxEvent {
  static readonly eventType = 'order.paid';
}

class NoEventTypeEvent extends OutboxEvent {}

describe('@OnOutboxEvent', () => {
  it('should set metadata with a single event type', () => {
    class TestHandler {
      @OnOutboxEvent(OrderCreatedEvent)
      handle() {}
    }

    const metadata = Reflect.getMetadata(
      OUTBOX_EVENT_METADATA,
      TestHandler.prototype.handle,
    );
    expect(metadata).toEqual(['order.created']);
  });

  it('should set metadata with multiple event types', () => {
    class TestHandler {
      @OnOutboxEvent(OrderCreatedEvent, OrderPaidEvent)
      handle() {}
    }

    const metadata = Reflect.getMetadata(
      OUTBOX_EVENT_METADATA,
      TestHandler.prototype.handle,
    );
    expect(metadata).toEqual(['order.created', 'order.paid']);
  });

  it('should throw if event class has no static eventType', () => {
    expect(() => {
      class TestHandler {
        @OnOutboxEvent(NoEventTypeEvent as any)
        handle() {}
      }
    }).toThrow('NoEventTypeEvent must define static readonly eventType');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --selectProjects unit -- test/outbox.decorator.spec.ts`
Expected: FAIL — `Cannot find module '../src/outbox.decorator'`

- [ ] **Step 3: Implement @OnOutboxEvent**

`src/outbox.decorator.ts`:
```typescript
import { SetMetadata } from '@nestjs/common';
import { OUTBOX_EVENT_METADATA } from './outbox.constants';
import type { OutboxEvent } from './outbox.event';

type OutboxEventClass = { eventType: string } & (new (
  ...args: any[]
) => OutboxEvent);

export function OnOutboxEvent(
  ...events: OutboxEventClass[]
): MethodDecorator {
  const eventTypes = events.map((e) => {
    if (!e.eventType || typeof e.eventType !== 'string') {
      throw new Error(
        `${e.name} must define static readonly eventType: string`,
      );
    }
    return e.eventType;
  });
  return SetMetadata(OUTBOX_EVENT_METADATA, eventTypes);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --selectProjects unit -- test/outbox.decorator.spec.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/outbox.decorator.ts test/outbox.decorator.spec.ts
git commit -m "feat: add @OnOutboxEvent decorator"
```

---

## Task 5: OutboxEmitter (TDD)

**Files:**
- Create: `test/outbox.emitter.spec.ts`
- Create: `src/outbox.emitter.ts`

- [ ] **Step 1: Write the failing tests**

`test/outbox.emitter.spec.ts`:
```typescript
import { OutboxEmitter } from '../src/outbox.emitter';
import { OutboxEvent } from '../src/outbox.event';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';

class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';

  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}

class OrderPaidEvent extends OutboxEvent {
  static readonly eventType = 'order.paid';

  constructor(public readonly orderId: string) {
    super();
  }
}

function createMockTx() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn(),
  };
}

function createEmitter(overrides?: Partial<OutboxOptions>): OutboxEmitter {
  const options: OutboxOptions = {
    prisma: {},
    retry: { maxRetries: 5 },
    ...overrides,
  };
  return new OutboxEmitter(options);
}

describe('OutboxEmitter', () => {
  describe('emit', () => {
    it('should call $executeRaw with event type and payload', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();
      const event = new OrderCreatedEvent('order-1', 99.99);

      await emitter.emit(tx, event);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = tx.$executeRaw.mock.calls[0];
      expect(values[0]).toBe('order.created');
      expect(values[1]).toBe(JSON.stringify({ orderId: 'order-1', total: 99.99 }));
      expect(values[2]).toBe(5); // maxRetries
    });

    it('should use custom maxRetries from options', async () => {
      const emitter = createEmitter({ retry: { maxRetries: 10 } });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50));

      const [, , , maxRetries] = tx.$executeRaw.mock.calls[0];
      expect(maxRetries).toBe(10);
    });

    it('should use default maxRetries when not specified', async () => {
      const emitter = createEmitter({ retry: undefined });
      const tx = createMockTx();

      await emitter.emit(tx, new OrderCreatedEvent('order-1', 50));

      const [, , , maxRetries] = tx.$executeRaw.mock.calls[0];
      expect(maxRetries).toBe(5);
    });
  });

  describe('emitMany', () => {
    it('should call $executeRaw once per event', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await emitter.emitMany(tx, [
        new OrderCreatedEvent('order-1', 100),
        new OrderPaidEvent('order-1'),
      ]);

      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);

      const firstCallValues = tx.$executeRaw.mock.calls[0].slice(1);
      expect(firstCallValues[0]).toBe('order.created');

      const secondCallValues = tx.$executeRaw.mock.calls[1].slice(1);
      expect(secondCallValues[0]).toBe('order.paid');
    });

    it('should handle empty array', async () => {
      const emitter = createEmitter();
      const tx = createMockTx();

      await emitter.emitMany(tx, []);

      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --selectProjects unit -- test/outbox.emitter.spec.ts`
Expected: FAIL — `Cannot find module '../src/outbox.emitter'`

- [ ] **Step 3: Implement OutboxEmitter**

`src/outbox.emitter.ts`:
```typescript
import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_MAX_RETRIES,
  OUTBOX_OPTIONS,
} from './outbox.constants';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { PrismaTransactionClient } from './interfaces/prisma-transaction-client.interface';
import type { OutboxEvent } from './outbox.event';

@Injectable()
export class OutboxEmitter {
  private readonly maxRetries: number;

  constructor(@Inject(OUTBOX_OPTIONS) options: OutboxOptions) {
    this.maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async emit(
    tx: PrismaTransactionClient,
    event: OutboxEvent,
  ): Promise<void> {
    const eventType = event.getEventType();
    const payload = JSON.stringify(event.toPayload());

    await tx.$executeRaw`
      INSERT INTO outbox_events (event_type, payload, max_retries)
      VALUES (${eventType}, ${payload}::jsonb, ${this.maxRetries})
    `;
  }

  async emitMany(
    tx: PrismaTransactionClient,
    events: OutboxEvent[],
  ): Promise<void> {
    for (const event of events) {
      await this.emit(tx, event);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --selectProjects unit -- test/outbox.emitter.spec.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/outbox.emitter.ts test/outbox.emitter.spec.ts
git commit -m "feat: add OutboxEmitter with emit and emitMany"
```

---

## Task 6: LocalTransport (TDD)

**Files:**
- Create: `test/local-transport.spec.ts`
- Create: `src/transports/local.transport.ts`

- [ ] **Step 1: Write the failing tests**

`test/local-transport.spec.ts`:
```typescript
import { LocalTransport } from '../src/transports/local.transport';
import type { OutboxRecord } from '../src/interfaces/outbox-record.interface';
import type { OutboxHandler } from '../src/interfaces/outbox-handler.interface';

function createRecord(overrides?: Partial<OutboxRecord>): OutboxRecord {
  return {
    id: 'record-1',
    eventType: 'order.created',
    payload: { orderId: 'order-1', total: 100 },
    status: 'PROCESSING',
    createdAt: new Date(),
    updatedAt: new Date(),
    processedAt: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    tenantId: null,
    ...overrides,
  };
}

describe('LocalTransport', () => {
  let transport: LocalTransport;

  beforeEach(() => {
    transport = new LocalTransport();
  });

  it('should call each handler sequentially with the payload', async () => {
    const callOrder: string[] = [];
    const handler1: OutboxHandler = {
      instance: {
        handle1: jest.fn(async () => {
          callOrder.push('handler1');
        }),
      },
      methodName: 'handle1',
      eventTypes: ['order.created'],
    };
    const handler2: OutboxHandler = {
      instance: {
        handle2: jest.fn(async () => {
          callOrder.push('handler2');
        }),
      },
      methodName: 'handle2',
      eventTypes: ['order.created'],
    };

    const record = createRecord();
    await transport.dispatch(record, [handler1, handler2]);

    expect(handler1.instance.handle1).toHaveBeenCalledWith(record.payload);
    expect(handler2.instance.handle2).toHaveBeenCalledWith(record.payload);
    expect(callOrder).toEqual(['handler1', 'handler2']);
  });

  it('should abort on first failure (all-or-nothing)', async () => {
    const handler1: OutboxHandler = {
      instance: {
        handle: jest.fn().mockRejectedValue(new Error('handler1 failed')),
      },
      methodName: 'handle',
      eventTypes: ['order.created'],
    };
    const handler2: OutboxHandler = {
      instance: { handle: jest.fn() },
      methodName: 'handle',
      eventTypes: ['order.created'],
    };

    const record = createRecord();
    await expect(
      transport.dispatch(record, [handler1, handler2]),
    ).rejects.toThrow('handler1 failed');

    expect(handler2.instance.handle).not.toHaveBeenCalled();
  });

  it('should resolve immediately for empty handlers', async () => {
    const record = createRecord();
    await expect(transport.dispatch(record, [])).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --selectProjects unit -- test/local-transport.spec.ts`
Expected: FAIL — `Cannot find module '../src/transports/local.transport'`

- [ ] **Step 3: Implement LocalTransport**

`src/transports/local.transport.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import type { OutboxHandler } from '../interfaces/outbox-handler.interface';
import type { OutboxRecord } from '../interfaces/outbox-record.interface';
import type { OutboxTransport } from '../interfaces/outbox-transport.interface';

@Injectable()
export class LocalTransport implements OutboxTransport {
  async dispatch(
    record: OutboxRecord,
    handlers: OutboxHandler[],
  ): Promise<void> {
    for (const handler of handlers) {
      await handler.instance[handler.methodName](record.payload);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --selectProjects unit -- test/local-transport.spec.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/local.transport.ts test/local-transport.spec.ts
git commit -m "feat: add LocalTransport for direct handler invocation"
```

---

## Task 7: OutboxExplorer (TDD)

**Files:**
- Create: `test/outbox.explorer.spec.ts`
- Create: `src/outbox.explorer.ts`

- [ ] **Step 1: Write the failing tests**

`test/outbox.explorer.spec.ts`:
```typescript
import { OutboxExplorer } from '../src/outbox.explorer';
import { OUTBOX_EVENT_METADATA } from '../src/outbox.constants';
import type { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { Reflector } from '@nestjs/core';

class FakeHandler {
  handleOrder() {}
  handlePayment() {}
  notDecorated() {}
}

function createExplorer(handlers: { instance: any; methodMetadata: Record<string, string[]> }[]) {
  const wrappers = handlers.map((h) => ({
    instance: h.instance,
    metatype: h.instance.constructor,
    token: h.instance.constructor,
    name: h.instance.constructor.name,
    isAlias: false,
  }));

  const mockDiscovery: Partial<DiscoveryService> = {
    getProviders: jest.fn().mockReturnValue(wrappers),
  };

  const mockScanner: Partial<MetadataScanner> = {
    getAllMethodNames: jest.fn((prototype: any) => {
      return Object.getOwnPropertyNames(prototype).filter(
        (name) => name !== 'constructor' && typeof prototype[name] === 'function',
      );
    }),
  };

  const mockReflector: Partial<Reflector> = {
    get: jest.fn((key: any, target: any) => {
      const handler = handlers.find((h) => {
        const proto = Object.getPrototypeOf(h.instance);
        return Object.values(proto).includes(target) ||
          Object.getOwnPropertyNames(proto).some((m) => proto[m] === target);
      });
      if (!handler) return undefined;
      const methodName = Object.getOwnPropertyNames(Object.getPrototypeOf(handler.instance))
        .find((m) => Object.getPrototypeOf(handler.instance)[m] === target);
      if (!methodName) return undefined;
      return handler.methodMetadata[methodName];
    }),
  };

  return new OutboxExplorer(
    mockDiscovery as DiscoveryService,
    mockScanner as MetadataScanner,
    mockReflector as Reflector,
  );
}

describe('OutboxExplorer', () => {
  it('should discover handlers and build eventType → handler map', () => {
    const instance = new FakeHandler();
    const explorer = createExplorer([
      {
        instance,
        methodMetadata: {
          handleOrder: ['order.created'],
          handlePayment: ['payment.completed'],
        },
      },
    ]);

    explorer.onModuleInit();

    const orderHandlers = explorer.getHandlers('order.created');
    expect(orderHandlers).toHaveLength(1);
    expect(orderHandlers[0].instance).toBe(instance);
    expect(orderHandlers[0].methodName).toBe('handleOrder');

    const paymentHandlers = explorer.getHandlers('payment.completed');
    expect(paymentHandlers).toHaveLength(1);
    expect(paymentHandlers[0].methodName).toBe('handlePayment');
  });

  it('should return empty array for unregistered event types', () => {
    const explorer = createExplorer([]);
    explorer.onModuleInit();

    expect(explorer.getHandlers('nonexistent')).toEqual([]);
  });

  it('should support multiple handlers for the same event type', () => {
    const instance1 = new FakeHandler();
    const instance2 = new FakeHandler();

    const explorer = createExplorer([
      { instance: instance1, methodMetadata: { handleOrder: ['order.created'] } },
      { instance: instance2, methodMetadata: { handleOrder: ['order.created'] } },
    ]);

    explorer.onModuleInit();

    const handlers = explorer.getHandlers('order.created');
    expect(handlers).toHaveLength(2);
  });

  it('should list all registered event types', () => {
    const explorer = createExplorer([
      {
        instance: new FakeHandler(),
        methodMetadata: {
          handleOrder: ['order.created'],
          handlePayment: ['payment.completed'],
        },
      },
    ]);

    explorer.onModuleInit();

    const types = explorer.getRegisteredEventTypes();
    expect(types).toContain('order.created');
    expect(types).toContain('payment.completed');
    expect(types).toHaveLength(2);
  });

  it('should skip providers without instances', () => {
    const mockDiscovery: Partial<DiscoveryService> = {
      getProviders: jest.fn().mockReturnValue([{ instance: null }]),
    };
    const mockScanner: Partial<MetadataScanner> = {
      getAllMethodNames: jest.fn().mockReturnValue([]),
    };
    const mockReflector: Partial<Reflector> = {
      get: jest.fn(),
    };

    const explorer = new OutboxExplorer(
      mockDiscovery as DiscoveryService,
      mockScanner as MetadataScanner,
      mockReflector as Reflector,
    );

    expect(() => explorer.onModuleInit()).not.toThrow();
    expect(explorer.getRegisteredEventTypes()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --selectProjects unit -- test/outbox.explorer.spec.ts`
Expected: FAIL — `Cannot find module '../src/outbox.explorer'`

- [ ] **Step 3: Implement OutboxExplorer**

`src/outbox.explorer.ts`:
```typescript
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { OUTBOX_EVENT_METADATA } from './outbox.constants';
import type { OutboxHandler } from './interfaces/outbox-handler.interface';

@Injectable()
export class OutboxExplorer implements OnModuleInit {
  private readonly logger = new Logger(OutboxExplorer.name);
  private readonly handlers = new Map<string, OutboxHandler[]>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const wrappers = this.discovery.getProviders();

    for (const wrapper of wrappers) {
      const { instance } = wrapper;
      if (!instance || typeof instance !== 'object') continue;

      const prototype = Object.getPrototypeOf(instance);
      if (!prototype) continue;

      const methodNames = this.metadataScanner.getAllMethodNames(prototype);

      for (const methodName of methodNames) {
        const eventTypes = this.reflector.get<string[]>(
          OUTBOX_EVENT_METADATA,
          prototype[methodName],
        );
        if (!eventTypes || eventTypes.length === 0) continue;

        const handler: OutboxHandler = {
          instance: instance as Record<string, any>,
          methodName,
          eventTypes,
        };

        for (const eventType of eventTypes) {
          const existing = this.handlers.get(eventType) ?? [];
          existing.push(handler);
          this.handlers.set(eventType, existing);
          this.logger.log(
            `Registered handler ${instance.constructor.name}.${methodName} for "${eventType}"`,
          );
        }
      }
    }
  }

  getHandlers(eventType: string): OutboxHandler[] {
    return this.handlers.get(eventType) ?? [];
  }

  getRegisteredEventTypes(): string[] {
    return [...this.handlers.keys()];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --selectProjects unit -- test/outbox.explorer.spec.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/outbox.explorer.ts test/outbox.explorer.spec.ts
git commit -m "feat: add OutboxExplorer for handler auto-discovery"
```

---

## Task 8: OutboxPoller (TDD)

**Files:**
- Create: `test/outbox.poller.spec.ts`
- Create: `src/outbox.poller.ts`

This is the most complex component. Tests mock Prisma, transport, explorer, and scheduler.

- [ ] **Step 1: Write the failing tests**

`test/outbox.poller.spec.ts`:
```typescript
import { OutboxPoller } from '../src/outbox.poller';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';
import type { OutboxTransport } from '../src/interfaces/outbox-transport.interface';
import type { OutboxRecord } from '../src/interfaces/outbox-record.interface';
import type { OutboxExplorer } from '../src/outbox.explorer';
import type { SchedulerRegistry } from '@nestjs/schedule';

function createRecord(overrides?: Partial<OutboxRecord>): OutboxRecord {
  return {
    id: 'evt-1',
    eventType: 'order.created',
    payload: { orderId: 'order-1' },
    status: 'PROCESSING',
    createdAt: new Date(),
    updatedAt: new Date(),
    processedAt: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    tenantId: null,
    ...overrides,
  };
}

function createMockPrisma(records: OutboxRecord[] = []) {
  return {
    $queryRaw: jest.fn().mockResolvedValue(records),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

function createMockTransport(): jest.Mocked<OutboxTransport> {
  return { dispatch: jest.fn().mockResolvedValue(undefined) };
}

function createMockExplorer(
  handlerMap: Record<string, any[]> = {},
): jest.Mocked<Pick<OutboxExplorer, 'getHandlers' | 'getRegisteredEventTypes'>> {
  return {
    getHandlers: jest.fn((eventType: string) => handlerMap[eventType] ?? []),
    getRegisteredEventTypes: jest.fn(() => Object.keys(handlerMap)),
  };
}

function createMockSchedulerRegistry(): jest.Mocked<Pick<SchedulerRegistry, 'addInterval' | 'deleteInterval'>> {
  return {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
  };
}

function createPoller(overrides?: {
  prisma?: any;
  transport?: any;
  explorer?: any;
  schedulerRegistry?: any;
  options?: Partial<OutboxOptions>;
}) {
  const prisma = overrides?.prisma ?? createMockPrisma();
  const options: OutboxOptions = {
    prisma,
    polling: { enabled: true, interval: 5000, batchSize: 10 },
    retry: { maxRetries: 3, backoff: 'exponential', initialDelay: 1000 },
    ...overrides?.options,
  };

  return new OutboxPoller(
    options,
    overrides?.transport ?? createMockTransport(),
    overrides?.explorer ?? createMockExplorer(),
    overrides?.schedulerRegistry ?? createMockSchedulerRegistry(),
  );
}

describe('OutboxPoller', () => {
  describe('onModuleInit', () => {
    it('should register interval with SchedulerRegistry', () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      const poller = createPoller({ schedulerRegistry });

      poller.onModuleInit();

      expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
        'outbox-poll',
        expect.anything(),
      );
    });

    it('should not register interval when polling is disabled', () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      const poller = createPoller({
        schedulerRegistry,
        options: { polling: { enabled: false } },
      });

      poller.onModuleInit();

      expect(schedulerRegistry.addInterval).not.toHaveBeenCalled();
    });
  });

  describe('poll', () => {
    it('should fetch events and dispatch to transport', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      const handler = { instance: {}, methodName: 'handle', eventTypes: ['order.created'] };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({ prisma, transport, explorer });
      await poller.poll();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(transport.dispatch).toHaveBeenCalledWith(record, [handler]);
      // Should mark as SENT
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('should mark event as SENT when no handlers exist', async () => {
      const record = createRecord();
      const prisma = createMockPrisma([record]);
      const explorer = createMockExplorer({}); // no handlers

      const poller = createPoller({ prisma, explorer });
      await poller.poll();

      // Should still call $executeRaw to mark SENT
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('should handle transport failure and increment retry count', async () => {
      const record = createRecord({ retryCount: 0 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('handler failed'));
      const handler = { instance: {}, methodName: 'handle', eventTypes: ['order.created'] };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({ prisma, transport, explorer });
      await poller.poll();

      // Should call $executeRaw to update retry_count and status
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('should mark as FAILED when max retries exceeded', async () => {
      const record = createRecord({ retryCount: 2, maxRetries: 3 });
      const prisma = createMockPrisma([record]);
      const transport = createMockTransport();
      transport.dispatch.mockRejectedValue(new Error('still failing'));
      const handler = { instance: {}, methodName: 'handle', eventTypes: ['order.created'] };
      const explorer = createMockExplorer({ 'order.created': [handler] });

      const poller = createPoller({
        prisma,
        transport,
        explorer,
        options: { retry: { maxRetries: 3 } },
      });
      await poller.poll();

      // Verify $executeRaw was called (status → FAILED)
      const executeRawCalls = prisma.$executeRaw.mock.calls;
      expect(executeRawCalls.length).toBeGreaterThan(0);
    });

    it('should not poll when shutting down', async () => {
      const prisma = createMockPrisma();
      const poller = createPoller({ prisma });

      await poller.onApplicationShutdown();
      await poller.poll();

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('should do nothing when no pending events', async () => {
      const prisma = createMockPrisma([]); // empty result
      const transport = createMockTransport();

      const poller = createPoller({ prisma, transport });
      await poller.poll();

      expect(transport.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('onApplicationShutdown', () => {
    it('should delete interval from SchedulerRegistry', async () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      const poller = createPoller({ schedulerRegistry });

      await poller.onApplicationShutdown();

      expect(schedulerRegistry.deleteInterval).toHaveBeenCalledWith('outbox-poll');
    });

    it('should not throw if interval was not registered', async () => {
      const schedulerRegistry = createMockSchedulerRegistry();
      schedulerRegistry.deleteInterval.mockImplementation(() => {
        throw new Error('No Interval was found');
      });

      const poller = createPoller({ schedulerRegistry });
      await expect(poller.onApplicationShutdown()).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --selectProjects unit -- test/outbox.poller.spec.ts`
Expected: FAIL — `Cannot find module '../src/outbox.poller'`

- [ ] **Step 3: Implement OutboxPoller**

`src/outbox.poller.ts`:
```typescript
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  DEFAULT_BACKOFF,
  DEFAULT_BATCH_SIZE,
  DEFAULT_INITIAL_DELAY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_POLLING_INTERVAL,
  DEFAULT_SHUTDOWN_TIMEOUT,
  DEFAULT_STUCK_THRESHOLD,
  OUTBOX_OPTIONS,
  OUTBOX_TRANSPORT,
  STUCK_RECOVERY_INTERVAL,
} from './outbox.constants';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { OutboxRecord } from './interfaces/outbox-record.interface';
import type { OutboxTransport } from './interfaces/outbox-transport.interface';
import { OutboxExplorer } from './outbox.explorer';

const POLL_INTERVAL_NAME = 'outbox-poll';

@Injectable()
export class OutboxPoller implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPoller.name);
  private isShuttingDown = false;
  private activeCount = 0;
  private pollCount = 0;

  private readonly pollingEnabled: boolean;
  private readonly interval: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private readonly backoff: 'fixed' | 'exponential';
  private readonly initialDelay: number;
  private readonly stuckThreshold: number;

  constructor(
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
    @Inject(OUTBOX_TRANSPORT) private readonly transport: OutboxTransport,
    private readonly explorer: OutboxExplorer,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.pollingEnabled = options.polling?.enabled ?? true;
    this.interval = options.polling?.interval ?? DEFAULT_POLLING_INTERVAL;
    this.batchSize = options.polling?.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxRetries = options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoff = options.retry?.backoff ?? DEFAULT_BACKOFF;
    this.initialDelay = options.retry?.initialDelay ?? DEFAULT_INITIAL_DELAY;
    this.stuckThreshold = options.stuckThreshold ?? DEFAULT_STUCK_THRESHOLD;
  }

  onModuleInit(): void {
    if (!this.pollingEnabled) return;

    const interval = setInterval(() => this.poll(), this.interval);
    this.schedulerRegistry.addInterval(POLL_INTERVAL_NAME, interval);
    this.logger.log(
      `Outbox poller started (interval: ${this.interval}ms, batch: ${this.batchSize})`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.isShuttingDown = true;

    try {
      this.schedulerRegistry.deleteInterval(POLL_INTERVAL_NAME);
    } catch {
      // Interval might not exist if polling was disabled
    }

    const start = Date.now();
    while (
      this.activeCount > 0 &&
      Date.now() - start < DEFAULT_SHUTDOWN_TIMEOUT
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.activeCount > 0) {
      this.logger.warn(
        `Shutdown timeout: ${this.activeCount} events still processing`,
      );
    }
  }

  async poll(): Promise<void> {
    if (this.isShuttingDown) return;

    this.pollCount++;

    if (this.pollCount % STUCK_RECOVERY_INTERVAL === 0) {
      await this.recoverStuckEvents();
    }

    const records = await this.fetchAndLock();

    for (const record of records) {
      if (this.isShuttingDown) break;

      this.activeCount++;
      try {
        const handlers = this.explorer.getHandlers(record.eventType);

        if (handlers.length === 0) {
          this.logger.warn(
            `No handlers for event type "${record.eventType}", marking as SENT`,
          );
          await this.markSent(record.id);
          continue;
        }

        await this.transport.dispatch(record, handlers);
        await this.markSent(record.id);
      } catch (error) {
        const err =
          error instanceof Error ? error : new Error(String(error));
        await this.handleFailure(record, err);
      } finally {
        this.activeCount--;
      }
    }
  }

  private async fetchAndLock(): Promise<OutboxRecord[]> {
    const prisma = this.options.prisma;
    const backoffType = this.backoff;
    const initialDelaySeconds = this.initialDelay / 1000;
    const batchSize = this.batchSize;

    return prisma.$queryRaw`
      UPDATE outbox_events
      SET status = 'PROCESSING', updated_at = NOW()
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE status = 'PENDING'
          AND (
            retry_count = 0
            OR updated_at < NOW() - make_interval(
              secs => CASE
                WHEN ${backoffType} = 'exponential'
                THEN ${initialDelaySeconds} * pow(2, retry_count - 1)
                ELSE ${initialDelaySeconds}
              END
            )
          )
        ORDER BY created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id,
        event_type AS "eventType",
        payload,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        processed_at AS "processedAt",
        retry_count AS "retryCount",
        max_retries AS "maxRetries",
        last_error AS "lastError",
        tenant_id AS "tenantId"
    `;
  }

  private async markSent(id: string): Promise<void> {
    const prisma = this.options.prisma;
    await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'SENT', processed_at = NOW(), updated_at = NOW()
      WHERE id = ${id}::uuid
    `;
  }

  private async handleFailure(
    record: OutboxRecord,
    error: Error,
  ): Promise<void> {
    const newRetryCount = record.retryCount + 1;
    const prisma = this.options.prisma;
    const errorMessage = error.message;

    if (newRetryCount >= this.maxRetries) {
      this.logger.error(
        `Event ${record.id} failed permanently after ${newRetryCount} retries: ${errorMessage}`,
      );
      await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'FAILED',
            retry_count = ${newRetryCount},
            last_error = ${errorMessage},
            updated_at = NOW()
        WHERE id = ${record.id}::uuid
      `;
    } else {
      this.logger.warn(
        `Event ${record.id} failed (retry ${newRetryCount}/${this.maxRetries}): ${errorMessage}`,
      );
      await prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'PENDING',
            retry_count = ${newRetryCount},
            last_error = ${errorMessage},
            updated_at = NOW()
        WHERE id = ${record.id}::uuid
      `;
    }
  }

  private async recoverStuckEvents(): Promise<void> {
    const prisma = this.options.prisma;
    const thresholdSeconds = this.stuckThreshold / 1000;

    const recovered = await prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'PENDING', updated_at = NOW()
      WHERE status = 'PROCESSING'
        AND updated_at < NOW() - make_interval(secs => ${thresholdSeconds})
    `;

    if (recovered > 0) {
      this.logger.warn(
        `Recovered ${recovered} stuck events from PROCESSING state`,
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --selectProjects unit -- test/outbox.poller.spec.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/outbox.poller.ts test/outbox.poller.spec.ts
git commit -m "feat: add OutboxPoller with retry, backoff, and graceful shutdown"
```

---

## Task 9: OutboxModule (TDD)

**Files:**
- Create: `test/outbox.module.spec.ts`
- Create: `src/outbox.module.ts`

- [ ] **Step 1: Write the failing tests**

`test/outbox.module.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { OutboxModule } from '../src/outbox.module';
import { OutboxEmitter } from '../src/outbox.emitter';
import { OUTBOX_OPTIONS, OUTBOX_TRANSPORT } from '../src/outbox.constants';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';
import type { OutboxTransport } from '../src/interfaces/outbox-transport.interface';

const mockPrisma = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
};

describe('OutboxModule', () => {
  describe('forRoot', () => {
    it('should provide OutboxEmitter', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma: mockPrisma,
            polling: { enabled: false },
          }),
        ],
      }).compile();

      const emitter = module.get(OutboxEmitter);
      expect(emitter).toBeInstanceOf(OutboxEmitter);
    });

    it('should provide OUTBOX_OPTIONS', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma: mockPrisma,
            polling: { enabled: false },
            retry: { maxRetries: 10 },
          }),
        ],
      }).compile();

      const options = module.get<OutboxOptions>(OUTBOX_OPTIONS);
      expect(options.retry?.maxRetries).toBe(10);
    });

    it('should provide OUTBOX_TRANSPORT', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma: mockPrisma,
            polling: { enabled: false },
          }),
        ],
      }).compile();

      const transport = module.get<OutboxTransport>(OUTBOX_TRANSPORT);
      expect(transport).toBeDefined();
      expect(typeof transport.dispatch).toBe('function');
    });
  });

  describe('forRootAsync', () => {
    it('should support useFactory', async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRootAsync({
            useFactory: () => ({
              prisma: mockPrisma,
              polling: { enabled: false },
              retry: { maxRetries: 7 },
            }),
          }),
        ],
      }).compile();

      const options = module.get<OutboxOptions>(OUTBOX_OPTIONS);
      expect(options.retry?.maxRetries).toBe(7);
    });

    it('should throw if no provider method is given', () => {
      expect(() => {
        OutboxModule.forRootAsync({});
      }).toThrow(
        'OutboxModule.forRootAsync requires one of: useFactory, useClass, or useExisting',
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest --selectProjects unit -- test/outbox.module.spec.ts`
Expected: FAIL — `Cannot find module '../src/outbox.module'`

- [ ] **Step 3: Implement OutboxModule**

`src/outbox.module.ts`:
```typescript
import {
  Module,
  type DynamicModule,
  type Provider,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { OUTBOX_OPTIONS, OUTBOX_TRANSPORT } from './outbox.constants';
import { OutboxEmitter } from './outbox.emitter';
import { OutboxExplorer } from './outbox.explorer';
import { OutboxPoller } from './outbox.poller';
import { LocalTransport } from './transports/local.transport';
import type {
  OutboxAsyncOptions,
  OutboxOptions,
  OutboxOptionsFactory,
} from './interfaces/outbox-options.interface';

@Module({})
export class OutboxModule {
  static forRoot(options: OutboxOptions): DynamicModule {
    const prismaRef = options.prisma;
    const isPrismaClass = typeof prismaRef === 'function';

    const optionsProvider: Provider = isPrismaClass
      ? {
          provide: OUTBOX_OPTIONS,
          inject: [prismaRef],
          useFactory: (prismaInstance: any): OutboxOptions => ({
            ...options,
            prisma: prismaInstance,
          }),
        }
      : {
          provide: OUTBOX_OPTIONS,
          useValue: options,
        };

    const transportProvider: Provider = {
      provide: OUTBOX_TRANSPORT,
      useClass: LocalTransport,
    };

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule, ScheduleModule.forRoot()],
      providers: [
        optionsProvider,
        transportProvider,
        OutboxEmitter,
        OutboxPoller,
        OutboxExplorer,
      ],
      exports: [OutboxEmitter, OUTBOX_OPTIONS, OUTBOX_TRANSPORT],
    };
  }

  static forRootAsync(options: OutboxAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);

    const transportProvider: Provider = {
      provide: OUTBOX_TRANSPORT,
      useClass: LocalTransport,
    };

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [
        DiscoveryModule,
        ScheduleModule.forRoot(),
        ...(options.imports ?? []),
      ],
      providers: [
        ...asyncProviders,
        transportProvider,
        OutboxEmitter,
        OutboxPoller,
        OutboxExplorer,
      ],
      exports: [OutboxEmitter, OUTBOX_OPTIONS, OUTBOX_TRANSPORT],
    };
  }

  private static createAsyncProviders(
    options: OutboxAsyncOptions,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: OUTBOX_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: OUTBOX_OPTIONS,
          useFactory: (factory: OutboxOptionsFactory) =>
            factory.createOutboxOptions(),
          inject: [options.useExisting],
        },
      ];
    }

    if (options.useClass) {
      const useClass: Type<OutboxOptionsFactory> = options.useClass;
      return [
        { provide: useClass, useClass },
        {
          provide: OUTBOX_OPTIONS,
          useFactory: (factory: OutboxOptionsFactory) =>
            factory.createOutboxOptions(),
          inject: [useClass],
        },
      ];
    }

    throw new Error(
      'OutboxModule.forRootAsync requires one of: useFactory, useClass, or useExisting',
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest --selectProjects unit -- test/outbox.module.spec.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/outbox.module.ts test/outbox.module.spec.ts
git commit -m "feat: add OutboxModule with forRoot and forRootAsync"
```

---

## Task 10: Public Exports (index.ts)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Create index.ts**

`src/index.ts`:
```typescript
// Module
export { OutboxModule } from './outbox.module';

// Core
export { OutboxEvent } from './outbox.event';
export { OutboxEmitter } from './outbox.emitter';
export { OnOutboxEvent } from './outbox.decorator';

// Transport
export { LocalTransport } from './transports/local.transport';

// Constants (injection tokens)
export {
  OUTBOX_OPTIONS,
  OUTBOX_TRANSPORT,
  OUTBOX_EVENT_METADATA,
} from './outbox.constants';

// Interfaces
export type {
  OutboxOptions,
  OutboxAsyncOptions,
  OutboxOptionsFactory,
  OutboxPollingOptions,
  OutboxRetryOptions,
} from './interfaces/outbox-options.interface';
export type { OutboxRecord } from './interfaces/outbox-record.interface';
export type { OutboxTransport } from './interfaces/outbox-transport.interface';
export type { OutboxHandler } from './interfaces/outbox-handler.interface';
export type { PrismaTransactionClient } from './interfaces/prisma-transaction-client.interface';
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: `dist/` directory created with `.js` and `.d.ts` files, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: add public API exports"
```

---

## Task 11: E2E Test

**Files:**
- Create: `docker-compose.yml`
- Create: `test/e2e/prisma/schema.prisma`
- Create: `test/e2e/outbox.e2e-spec.ts`

Requires Docker for PostgreSQL.

- [ ] **Step 1: Create docker-compose.yml**

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
      POSTGRES_DB: outbox_test
    ports:
      - '5433:5432'
    tmpfs:
      - /var/lib/postgresql/data
```

- [ ] **Step 2: Create test Prisma schema**

`test/e2e/prisma/schema.prisma`:
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}
```

- [ ] **Step 3: Create .env for e2e tests**

Create `.env` at project root (already in .gitignore):
```
DATABASE_URL=postgresql://test:test@localhost:5433/outbox_test
```

- [ ] **Step 4: Generate Prisma client and start database**

Run:
```bash
docker compose up -d
npm run prisma:generate
```
Expected: PostgreSQL running on port 5433, Prisma client generated.

- [ ] **Step 5: Write E2E test**

`test/e2e/outbox.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { Injectable, type INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { OutboxModule } from '../../src/outbox.module';
import { OutboxEmitter } from '../../src/outbox.emitter';
import { OutboxEvent } from '../../src/outbox.event';
import { OnOutboxEvent } from '../../src/outbox.decorator';

// --- Test event ---
class OrderCreatedEvent extends OutboxEvent {
  static readonly eventType = 'order.created';
  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}

// --- Test PrismaService ---
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

// --- Test listener ---
@Injectable()
class TestListener {
  readonly received: Record<string, unknown>[] = [];

  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated(payload: Record<string, unknown>) {
    this.received.push(payload);
  }
}

// --- Failing listener ---
@Injectable()
class FailingListener {
  callCount = 0;

  @OnOutboxEvent(OrderCreatedEvent)
  async handleOrderCreated() {
    this.callCount++;
    if (this.callCount <= 2) {
      throw new Error(`Fail attempt ${this.callCount}`);
    }
  }
}

const MIGRATION_SQL = `
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
`;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Outbox E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let emitter: OutboxEmitter;
  let listener: TestListener;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.$executeRawUnsafe(MIGRATION_SQL);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS outbox_events');
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE outbox_events');
  });

  describe('basic flow', () => {
    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma,
            polling: { enabled: true, interval: 500, batchSize: 10 },
            retry: { maxRetries: 3, backoff: 'fixed', initialDelay: 500 },
          }),
        ],
        providers: [TestListener],
      }).compile();

      app = module.createNestApplication();
      await app.init();

      emitter = module.get(OutboxEmitter);
      listener = module.get(TestListener);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should emit event in transaction and deliver via poller', async () => {
      await prisma.$transaction(async (tx: any) => {
        await emitter.emit(tx, new OrderCreatedEvent('order-1', 99.99));
      });

      // Verify PENDING record exists
      const pending = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE event_type = 'order.created'
      `;
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe('PENDING');

      // Wait for poller to process
      await sleep(1500);

      // Verify handler was called
      expect(listener.received).toHaveLength(1);
      expect(listener.received[0]).toEqual({
        orderId: 'order-1',
        total: 99.99,
      });

      // Verify status is SENT
      const sent = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE id = ${pending[0].id}::uuid
      `;
      expect(sent[0].status).toBe('SENT');
      expect(sent[0].processed_at).not.toBeNull();
    });

    it('should rollback outbox event when transaction fails', async () => {
      await expect(
        prisma.$transaction(async (tx: any) => {
          await emitter.emit(tx, new OrderCreatedEvent('order-2', 50));
          throw new Error('Business logic failed');
        }),
      ).rejects.toThrow('Business logic failed');

      const records = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE event_type = 'order.created'
      `;
      expect(records).toHaveLength(0);
    });

    it('should emit multiple events with emitMany', async () => {
      await prisma.$transaction(async (tx: any) => {
        await emitter.emitMany(tx, [
          new OrderCreatedEvent('order-3', 10),
          new OrderCreatedEvent('order-4', 20),
        ]);
      });

      const records = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events ORDER BY created_at
      `;
      expect(records).toHaveLength(2);
    });
  });

  describe('retry flow', () => {
    let failingListener: FailingListener;

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [
          OutboxModule.forRoot({
            prisma,
            polling: { enabled: true, interval: 500, batchSize: 10 },
            retry: { maxRetries: 5, backoff: 'fixed', initialDelay: 100 },
          }),
        ],
        providers: [FailingListener],
      }).compile();

      app = module.createNestApplication();
      await app.init();

      emitter = module.get(OutboxEmitter);
      failingListener = module.get(FailingListener);
    });

    afterAll(async () => {
      await app.close();
    });

    it('should retry failed events and eventually succeed', async () => {
      await prisma.$transaction(async (tx: any) => {
        await emitter.emit(tx, new OrderCreatedEvent('order-retry', 100));
      });

      // Wait for multiple poll cycles (fail, fail, succeed)
      await sleep(3000);

      expect(failingListener.callCount).toBeGreaterThanOrEqual(3);

      const records = await prisma.$queryRaw<any[]>`
        SELECT * FROM outbox_events WHERE event_type = 'order.created'
      `;
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe('SENT');
    });
  });
});
```

- [ ] **Step 6: Run E2E tests**

Run:
```bash
docker compose up -d
npx jest --selectProjects e2e --runInBand
```
Expected: All E2E tests PASS.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml test/e2e/
git commit -m "test: add E2E tests with real PostgreSQL"
```

---

## Task 12: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write README**

Update `README.md` with:
- Package description and badge placeholders
- Installation instructions (`npm install @nestarc/outbox`)
- Quick start: module registration, event definition, emitting, listening
- SQL migration instructions (reference to `sql/create-outbox-table.sql`)
- Configuration reference (all options with defaults)
- How retry/backoff works
- Multi-instance safety (SKIP LOCKED)
- Graceful shutdown behavior
- Link to `@nestarc/tenancy` and `@nestarc/idempotency`

Structure:
1. **Header** — package name, one-line description, npm badge
2. **Installation** — `npm install @nestarc/outbox @nestjs/schedule @prisma/client`
3. **Quick Start** — 4 code blocks: module registration, event class, emit in transaction, listener
4. **SQL Migration** — `cat node_modules/@nestarc/outbox/src/sql/create-outbox-table.sql` or copy content
5. **Configuration** — table of all options with types and defaults
6. **Retry & Backoff** — how fixed/exponential work, max retries behavior
7. **Multi-Instance Safety** — explain FOR UPDATE SKIP LOCKED
8. **Graceful Shutdown** — behavior description
9. **Custom Transport** — how to implement `OutboxTransport` interface for v0.2
10. **Ecosystem** — links to `@nestarc/tenancy` and `@nestarc/idempotency`
11. **License** — MIT

- [ ] **Step 2: Final verification**

Run:
```bash
npm run build
npm run test
npm run test:e2e
```
Expected: Build succeeds, all unit tests pass, all E2E tests pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with usage guide and configuration reference"
```

---

## Post-Implementation Checklist

- [ ] All unit tests pass (`npm test`)
- [ ] All E2E tests pass (`npm run test:e2e`)
- [ ] Build succeeds (`npm run build`)
- [ ] Coverage >= 80% (`npm run test:cov`)
- [ ] `dist/` exports match `src/index.ts`
- [ ] SQL migration file is included in `dist/` (update `files` in package.json if needed)
- [ ] No lint errors (`npm run lint`)
