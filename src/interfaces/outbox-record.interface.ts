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
