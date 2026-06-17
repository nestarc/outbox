export interface OutboxNotification {
  channel: string;
  payload?: string;
}

export interface OutboxNotificationClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: string, handler: (payload: any) => void): this;
}

export interface OutboxWakeupOptions {
  enabled?: boolean;
  channel?: string;
  connectionString?: string;
  reconnectDelay?: number;
  clientFactory?: () =>
    | OutboxNotificationClient
    | Promise<OutboxNotificationClient | null>
    | null;
}
