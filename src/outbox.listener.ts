import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createRequire } from 'node:module';
import { OUTBOX_OPTIONS } from './outbox.constants';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { OutboxNotificationClient } from './interfaces/outbox-wakeup.interface';
import { OutboxPoller } from './outbox.poller';

const DEFAULT_WAKEUP_CHANNEL = 'outbox_events';
const DEFAULT_RECONNECT_DELAY = 5_000;

type PgClientConstructor = new (options: {
  connectionString?: string;
}) => OutboxNotificationClient;

const nodeRequire = createRequire(__filename);

@Injectable()
export class OutboxListener implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxListener.name);
  private client: OutboxNotificationClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
    @Inject(OutboxPoller)
    private readonly poller: Pick<OutboxPoller, 'poll'>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.wakeup?.enabled) return;
    await this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  private async connect(): Promise<void> {
    const client = await this.createClient();
    if (!client) return;

    const channel = this.getChannel();
    client.on('notification', (notification) => {
      if (notification.channel !== channel) return;
      void this.poller.poll().catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`Outbox wakeup poll failed: ${err.message}`);
      });
    });
    client.on('error', (error) => {
      this.logger.warn(`Outbox LISTEN/NOTIFY client error: ${error.message}`);
      this.scheduleReconnect();
    });

    await client.connect();
    await client.query(`LISTEN ${this.quoteIdentifier(channel)}`);
    this.client = client;
  }

  private async createClient(): Promise<OutboxNotificationClient | null> {
    const factory = this.options.wakeup?.clientFactory;
    if (factory) {
      return factory();
    }

    const Client = this.loadPgClient();
    if (!Client) {
      this.logger.warn(
        'Outbox wakeup enabled but "pg" is not installed; continuing with polling fallback',
      );
      return null;
    }

    return new Client({
      connectionString: this.options.wakeup?.connectionString,
    });
  }

  private loadPgClient(): PgClientConstructor | null {
    try {
      const pg = nodeRequire('pg') as { Client?: PgClientConstructor };
      return pg.Client ?? null;
    } catch {
      return null;
    }
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.reconnectTimer) return;

    const delay =
      this.options.wakeup?.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`Outbox LISTEN/NOTIFY reconnect failed: ${err.message}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private getChannel(): string {
    return this.options.wakeup?.channel ?? DEFAULT_WAKEUP_CHANNEL;
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
}
