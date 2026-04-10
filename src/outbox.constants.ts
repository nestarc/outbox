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
