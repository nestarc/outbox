import type { OutboxRecord } from './outbox-record.interface';

export interface OutboxStats {
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  oldestPendingAgeMs: number | null;
  oldestProcessingAgeMs: number | null;
}

export interface OutboxListOptions {
  status?: OutboxRecord['status'];
  eventType?: string;
  tenantId?: string;
  limit?: number;
  before?: Date;
  after?: Date;
}

export interface OutboxHealthOptions {
  maxOldestPendingAgeMs?: number;
  maxFailedCount?: number;
}

export interface OutboxHealth {
  ok: boolean;
  stats: OutboxStats;
  reasons: string[];
}

export type OutboxAdminMutationResult =
  | { outcome: 'applied' }
  | { outcome: 'not_found' }
  | {
      outcome: 'conflict';
      currentStatus: OutboxRecord['status'];
    }
  | { outcome: 'lost_claim' };
