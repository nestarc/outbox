# Broker-capable Transport Mode Implementation Plan

> [!IMPORTANT]
> **HISTORICAL / COMPLETED / SUPERSEDED.** publisher mode 구현을 완료할 때 쓴
> 계획이며 현재 계약이나 작업 큐가 아니다. 현재 계약은 루트
> [`README.md`](../../../README.md), 현재 작업 상태는
> [`2026-09-02-p0-p4-maintenance-work-plan.md`](../../2026-09-02-p0-p4-maintenance-work-plan.md)를
> 따른다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow broker-style outbox transports to publish records without requiring local `@OnOutboxEvent()` handlers, while preserving v0.1 local-handler behavior by default.

**Architecture:** Add a `delivery.mode` option with default `local`. In local mode, keep the current handler lookup and no-handler `FAILED` safety. In publisher mode, bypass local handler requirements and call either a new `OutboxPublisher.publish(record)` method or legacy `OutboxTransport.dispatch(record, [])` for backward-compatible custom transports.

**Tech Stack:** TypeScript, NestJS dependency injection, Jest unit tests, existing Prisma raw SQL poller.

---

## File Map

- Modify `src/interfaces/outbox-options.interface.ts`: add `OutboxDeliveryOptions` and `delivery?: OutboxDeliveryOptions`.
- Create `src/interfaces/outbox-publisher.interface.ts`: define `OutboxPublisher`.
- Modify `src/interfaces/outbox-transport.interface.ts`: keep legacy `OutboxTransport` unchanged for compatibility.
- Modify `src/outbox.poller.ts`: branch between local and publisher delivery modes.
- Modify `src/index.ts`: export `OutboxPublisher` and `OutboxDeliveryOptions`.
- Modify `test/outbox.poller.spec.ts`: add failing tests for publisher mode without handlers and publisher failures.
- Modify `test/outbox.module.spec.ts`: add compile/runtime coverage for publisher-only custom transport registration if needed.

---

### Task 1: Add failing poller tests for publisher mode

**Files:**
- Modify: `test/outbox.poller.spec.ts`

- [x] **Step 1: Add tests**

Add tests under `describe('poll')`:

```typescript
it('should publish events in publisher mode without registered handlers', async () => {
  const record = createRecord();
  const prisma = createMockPrisma([record]);
  const publisher = { publish: jest.fn().mockResolvedValue(undefined) };
  const explorer = createMockExplorer({});

  const poller = createPoller({
    prisma,
    transport: publisher,
    explorer,
    options: { delivery: { mode: 'publisher' } },
  });
  await poller.poll();

  expect(explorer.getHandlers).not.toHaveBeenCalled();
  expect(publisher.publish).toHaveBeenCalledWith(record);
  const sql = prisma.$executeRaw.mock.calls[0][0].join('');
  expect(sql).toContain('SENT');
});

it('should retry publisher mode failures without requiring handlers', async () => {
  const record = createRecord({ retryCount: 1, maxRetries: 5 });
  const prisma = createMockPrisma([record]);
  const publisher = {
    publish: jest.fn().mockRejectedValue(new Error('broker unavailable')),
  };
  const explorer = createMockExplorer({});

  const poller = createPoller({
    prisma,
    transport: publisher,
    explorer,
    options: { delivery: { mode: 'publisher' } },
  });
  await poller.poll();

  expect(explorer.getHandlers).not.toHaveBeenCalled();
  expect(publisher.publish).toHaveBeenCalledWith(record);
  const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
  expect(strings.join('')).toContain('PENDING');
  expect(values).toContain(2);
  expect(values).toContain('broker unavailable');
});

it('should support legacy dispatch transports in publisher mode without handlers', async () => {
  const record = createRecord();
  const prisma = createMockPrisma([record]);
  const transport = createMockTransport();
  const explorer = createMockExplorer({});

  const poller = createPoller({
    prisma,
    transport,
    explorer,
    options: { delivery: { mode: 'publisher' } },
  });
  await poller.poll();

  expect(explorer.getHandlers).not.toHaveBeenCalled();
  expect(transport.dispatch).toHaveBeenCalledWith(record, []);
  const sql = prisma.$executeRaw.mock.calls[0][0].join('');
  expect(sql).toContain('SENT');
});
```

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- --runInBand test/outbox.poller.spec.ts
```

Expected: TypeScript/Jest fails because `delivery` is not part of `OutboxOptions` and publisher mode is not implemented.

---

### Task 2: Add public publisher and delivery option types

**Files:**
- Create: `src/interfaces/outbox-publisher.interface.ts`
- Modify: `src/interfaces/outbox-options.interface.ts`
- Modify: `src/index.ts`

- [x] **Step 1: Create publisher interface**

```typescript
import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxPublisher {
  publish(record: OutboxRecord): Promise<void>;
}
```

- [x] **Step 2: Add delivery options**

In `src/interfaces/outbox-options.interface.ts`:

```typescript
export interface OutboxDeliveryOptions {
  mode?: 'local' | 'publisher';
}
```

Add to `OutboxOptions`:

```typescript
delivery?: OutboxDeliveryOptions;
```

- [x] **Step 3: Export public types**

In `src/index.ts`, export:

```typescript
export type { OutboxPublisher } from './interfaces/outbox-publisher.interface';
```

and include `OutboxDeliveryOptions` in the existing options type export.

---

### Task 3: Implement publisher mode in poller

**Files:**
- Modify: `src/outbox.poller.ts`

- [x] **Step 1: Add delivery mode field**

Add:

```typescript
private readonly deliveryMode: 'local' | 'publisher';
```

Set in constructor:

```typescript
this.deliveryMode = options.delivery?.mode ?? 'local';
```

- [x] **Step 2: Add type guards**

```typescript
function hasPublish(transport: unknown): transport is OutboxPublisher {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as { publish?: unknown }).publish === 'function'
  );
}

function hasDispatch(transport: unknown): transport is OutboxTransport {
  return (
    typeof transport === 'object' &&
    transport !== null &&
    typeof (transport as { dispatch?: unknown }).dispatch === 'function'
  );
}
```

- [x] **Step 3: Extract dispatch helper**

```typescript
private async dispatchRecord(record: OutboxRecord): Promise<boolean> {
  if (this.deliveryMode === 'publisher') {
    if (hasPublish(this.transport)) {
      await this.transport.publish(record);
      return true;
    }

    if (hasDispatch(this.transport)) {
      await this.transport.dispatch(record, []);
      return true;
    }

    throw new Error(
      'Outbox publisher mode requires a transport with publish(record) or dispatch(record, handlers)',
    );
  }

  const handlers = this.explorer.getHandlers(record.eventType);

  if (handlers.length === 0) {
    this.logger.error(
      `No handlers for event type "${record.eventType}", marking as FAILED`,
    );
    await this.markFailed(
      record.id,
      `No registered handlers for event type "${record.eventType}"`,
    );
    return false;
  }

  if (!hasDispatch(this.transport)) {
    throw new Error(
      'Outbox local mode requires a transport with dispatch(record, handlers)',
    );
  }

  await this.transport.dispatch(record, handlers);
  return true;
}
```

- [x] **Step 4: Replace inline handler/transport block**

In `poll()`, replace the handler lookup and transport call with:

```typescript
const dispatched = await this.dispatchRecord(record);
if (dispatched === false) continue;
await this.markSent(record.id);
```

---

### Task 4: Verify

**Files:**
- No new files unless implementation requires small type-only imports.

- [x] **Step 1: Run focused tests**

```bash
npm test -- --runInBand test/outbox.poller.spec.ts
```

Expected: poller tests pass.

- [x] **Step 2: Run full unit suite**

```bash
npm test -- --runInBand
```

Expected: all unit tests pass.

- [x] **Step 3: Run build**

```bash
npm run build
```

Expected: TypeScript build succeeds.
