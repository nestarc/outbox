import {
  DEFAULT_HEARTBEAT_FAILURE_TOLERANCE,
  DEFAULT_INITIAL_DELAY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_DELAY,
  DEFAULT_STUCK_THRESHOLD,
  MAX_SAFE_RETRY_DELAY,
} from './outbox.constants';
import { OutboxConfigurationError } from './errors/outbox-configuration.error';
import { OutboxPersistedInvariantError } from './errors/outbox-persisted-invariant.error';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { OutboxRecord } from './interfaces/outbox-record.interface';
import type { OutboxPublisher } from './interfaces/outbox-publisher.interface';
import type { OutboxTransport } from './interfaces/outbox-transport.interface';
import { LocalTransport } from './transports/local.transport';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_BATCH_SIZE = 10_000;
const STATUSES = new Set<OutboxRecord['status']>([
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED',
]);

export interface ClaimedOutboxRecord extends OutboxRecord {
  readonly claimToken: string;
}

export function validateOutboxOptions(options: OutboxOptions): OutboxOptions {
  if (!options || typeof options !== 'object') {
    throw new OutboxConfigurationError('options', 'must be an object');
  }

  assertPrisma(options.prisma);
  assertOptionalObject('polling', options.polling);
  assertOptionalObject('retry', options.retry);
  assertOptionalObject('delivery', options.delivery);
  assertOptionalObject('wakeup', options.wakeup);
  assertOptionalObject('lease', options.lease);
  assertBoolean('isGlobal', options.isGlobal);
  assertBoolean('polling.enabled', options.polling?.enabled);
  assertSafeInteger(
    'polling.interval',
    options.polling?.interval,
    1,
    MAX_SAFE_RETRY_DELAY,
  );
  assertSafeInteger(
    'polling.batchSize',
    options.polling?.batchSize,
    1,
    MAX_BATCH_SIZE,
  );
  assertSafeInteger(
    'retry.maxRetries',
    options.retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    1,
    POSTGRES_INTEGER_MAX,
  );
  assertEnum('retry.backoff', options.retry?.backoff, [
    'fixed',
    'exponential',
  ] as const);

  const initialDelay = options.retry?.initialDelay ?? DEFAULT_INITIAL_DELAY;
  const maxDelay = options.retry?.maxDelay ?? DEFAULT_MAX_RETRY_DELAY;
  if (
    !Number.isSafeInteger(initialDelay) ||
    initialDelay < 0 ||
    initialDelay > MAX_SAFE_RETRY_DELAY
  ) {
    throw new OutboxConfigurationError(
      'retry.initialDelay',
      `must be a non-negative safe integer no greater than ${MAX_SAFE_RETRY_DELAY}`,
    );
  }
  if (
    !Number.isSafeInteger(maxDelay) ||
    maxDelay <= 0 ||
    maxDelay > MAX_SAFE_RETRY_DELAY
  ) {
    throw new OutboxConfigurationError(
      'retry.maxDelay',
      `must be a positive safe integer no greater than ${MAX_SAFE_RETRY_DELAY}`,
    );
  }
  if (initialDelay > maxDelay) {
    throw new OutboxConfigurationError(
      'retry.initialDelay',
      'must be less than or equal to retry.maxDelay',
    );
  }

  assertEnum('delivery.mode', options.delivery?.mode, [
    'local',
    'publisher',
  ] as const);
  assertBoolean('wakeup.enabled', options.wakeup?.enabled);
  assertSafeInteger(
    'wakeup.reconnectDelay',
    options.wakeup?.reconnectDelay,
    1,
    MAX_SAFE_RETRY_DELAY,
  );

  assertSafeInteger(
    'stuckThreshold',
    options.stuckThreshold,
    1,
    MAX_SAFE_RETRY_DELAY,
  );
  const leaseDuration =
    options.lease?.duration ??
    options.stuckThreshold ??
    DEFAULT_STUCK_THRESHOLD;
  if (
    !Number.isSafeInteger(leaseDuration) ||
    leaseDuration <= 0 ||
    leaseDuration > MAX_SAFE_RETRY_DELAY
  ) {
    throw new OutboxConfigurationError(
      'lease.duration',
      `must be a positive finite number and safe integer no greater than ${MAX_SAFE_RETRY_DELAY}`,
    );
  }
  const heartbeatInterval =
    options.lease?.heartbeatInterval ??
    Math.max(1, Math.floor(leaseDuration / 3));
  if (
    !Number.isSafeInteger(heartbeatInterval) ||
    heartbeatInterval <= 0 ||
    heartbeatInterval > MAX_SAFE_RETRY_DELAY ||
    heartbeatInterval >= leaseDuration / 2
  ) {
    throw new OutboxConfigurationError(
      'lease.heartbeatInterval',
      'must be positive and less than lease.duration / 2',
    );
  }
  const heartbeatFailureTolerance =
    options.lease?.heartbeatFailureTolerance ??
    DEFAULT_HEARTBEAT_FAILURE_TOLERANCE;
  if (
    !Number.isSafeInteger(heartbeatFailureTolerance) ||
    heartbeatFailureTolerance < 0 ||
    heartbeatFailureTolerance > POSTGRES_INTEGER_MAX
  ) {
    throw new OutboxConfigurationError(
      'lease.heartbeatFailureTolerance',
      `must be a non-negative integer no greater than ${POSTGRES_INTEGER_MAX}`,
    );
  }

  return options;
}

export function validateDeliveryTransport(
  options: OutboxOptions,
  transport: OutboxTransport | OutboxPublisher,
): void {
  const mode = options.delivery?.mode ?? 'local';
  const candidate = transport as Partial<OutboxTransport & OutboxPublisher>;

  if (mode === 'local' && typeof candidate.dispatch !== 'function') {
    throw new OutboxConfigurationError(
      'transport',
      'must implement dispatch() when delivery.mode is local',
    );
  }

  if (mode === 'publisher') {
    if (transport?.constructor === LocalTransport) {
      throw new OutboxConfigurationError(
        'transport',
        'must not use the default LocalTransport when delivery.mode is publisher',
      );
    }
    if (
      typeof candidate.publish !== 'function' &&
      typeof candidate.dispatch !== 'function'
    ) {
      throw new OutboxConfigurationError(
        'transport',
        'must implement publish() or legacy dispatch() when delivery.mode is publisher',
      );
    }
  }
}

export function parsePersistedOutboxRecord(row: unknown): OutboxRecord {
  return parseRecord(row, false);
}

export function parseClaimedOutboxRecord(row: unknown): ClaimedOutboxRecord {
  const record = parseRecord(row, true) as ClaimedOutboxRecord;
  if (record.status !== 'PROCESSING') {
    fail(record.id, 'status', 'must be PROCESSING after a successful claim');
  }
  return record;
}

function parseRecord(row: unknown, claimed: boolean): OutboxRecord {
  if (!isObject(row)) {
    fail(null, 'row', 'must be an object');
  }

  const id = requiredString(null, 'id', read(row, 'id'));
  const status = read(row, 'status');
  if (
    typeof status !== 'string' ||
    !STATUSES.has(status as OutboxRecord['status'])
  ) {
    fail(id, 'status', 'must be PENDING, PROCESSING, SENT, or FAILED');
  }

  const record: OutboxRecord = {
    id,
    eventType: requiredString(
      id,
      'event_type',
      read(row, 'event_type', 'eventType'),
    ),
    payload: jsonObject(id, 'payload', read(row, 'payload')),
    status: status as OutboxRecord['status'],
    createdAt: requiredDate(
      id,
      'created_at',
      read(row, 'created_at', 'createdAt'),
    ),
    updatedAt: requiredDate(
      id,
      'updated_at',
      read(row, 'updated_at', 'updatedAt'),
    ),
    processedAt: nullableDate(
      id,
      'processed_at',
      read(row, 'processed_at', 'processedAt'),
    ),
    nextAttemptAt: nullableDate(
      id,
      'next_attempt_at',
      read(row, 'next_attempt_at', 'nextAttemptAt'),
    ),
    retryCount: integer(
      id,
      'retry_count',
      read(row, 'retry_count', 'retryCount'),
      0,
      POSTGRES_INTEGER_MAX,
    ),
    maxRetries: integer(
      id,
      'max_retries',
      read(row, 'max_retries', 'maxRetries'),
      1,
      POSTGRES_INTEGER_MAX,
    ),
    lastError: nullableString(
      id,
      'last_error',
      read(row, 'last_error', 'lastError'),
    ),
    tenantId: nullableString(
      id,
      'tenant_id',
      read(row, 'tenant_id', 'tenantId'),
    ),
    aggregateType: nullableString(
      id,
      'aggregate_type',
      read(row, 'aggregate_type', 'aggregateType'),
    ),
    aggregateId: nullableString(
      id,
      'aggregate_id',
      read(row, 'aggregate_id', 'aggregateId'),
    ),
    partitionKey: nullableString(
      id,
      'partition_key',
      read(row, 'partition_key', 'partitionKey'),
    ),
    idempotencyKey: nullableString(
      id,
      'idempotency_key',
      read(row, 'idempotency_key', 'idempotencyKey'),
    ),
    correlationId: nullableString(
      id,
      'correlation_id',
      read(row, 'correlation_id', 'correlationId'),
    ),
    causationId: nullableString(
      id,
      'causation_id',
      read(row, 'causation_id', 'causationId'),
    ),
    headers: headers(id, read(row, 'headers')),
    occurredAt: requiredDate(
      id,
      'occurred_at',
      read(row, 'occurred_at', 'occurredAt'),
    ),
  };

  if (!claimed) return record;
  const claimToken = requiredString(
    id,
    'claim_token',
    read(row, 'claim_token', 'claimToken'),
  );
  return { ...record, claimToken } as ClaimedOutboxRecord;
}

function assertBoolean(option: string, value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new OutboxConfigurationError(option, 'must be a boolean');
  }
}

function assertOptionalObject(option: string, value: unknown): void {
  if (value !== undefined && !isObject(value)) {
    throw new OutboxConfigurationError(option, 'must be an object');
  }
}

function assertPrisma(value: unknown): void {
  const prisma = value as {
    $queryRaw?: unknown;
    $executeRaw?: unknown;
  } | null;
  if (
    !prisma ||
    typeof prisma.$queryRaw !== 'function' ||
    typeof prisma.$executeRaw !== 'function'
  ) {
    throw new OutboxConfigurationError(
      'prisma',
      'must provide $queryRaw and $executeRaw functions',
    );
  }
}

function assertSafeInteger(
  option: string,
  value: unknown,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined) return;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new OutboxConfigurationError(
      option,
      `must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
}

function assertEnum<T extends string>(
  option: string,
  value: unknown,
  allowed: readonly T[],
): void {
  if (value !== undefined && !allowed.includes(value as T)) {
    throw new OutboxConfigurationError(
      option,
      `must be one of: ${allowed.join(', ')}`,
    );
  }
}

function read(
  row: Record<string, unknown>,
  snakeCase: string,
  camelCase = snakeCase,
): unknown {
  return row[snakeCase] ?? row[camelCase];
}

function requiredString(
  id: string | null,
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(id, field, 'must be a non-empty string');
  }
  return value;
}

function nullableString(
  id: string,
  field: string,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(id, field, 'must be a string or null');
  return value;
}

function integer(
  id: string,
  field: string,
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(id, field, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function jsonObject(
  id: string,
  field: string,
  value: unknown,
): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      fail(id, field, 'must contain valid JSON');
    }
  }
  if (!isObject(parsed)) fail(id, field, 'must be a JSON object');
  return parsed;
}

function headers(id: string, value: unknown): Record<string, string> {
  const parsed = jsonObject(id, 'headers', value);
  return Object.fromEntries(
    Object.entries(parsed).map(([key, entry]) => [key, String(entry)]),
  );
}

function requiredDate(id: string, field: string, value: unknown): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(date.getTime())) fail(id, field, 'must be a valid date');
  return date;
}

function nullableDate(id: string, field: string, value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return requiredDate(id, field, value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(eventId: string | null, field: string, message: string): never {
  throw new OutboxPersistedInvariantError(eventId, field, message);
}
