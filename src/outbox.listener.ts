import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createRequire } from 'node:module';
import { OUTBOX_OPTIONS } from './outbox.constants';
import { OutboxWakeupUnavailableError } from './errors/outbox-wakeup-unavailable.error';
import type { OutboxOptions } from './interfaces/outbox-options.interface';
import type { OutboxNotificationClient } from './interfaces/outbox-wakeup.interface';
import { OutboxPoller } from './outbox.poller';

const DEFAULT_WAKEUP_CHANNEL = 'outbox_events';
const DEFAULT_RECONNECT_DELAY = 5_000;
const MAX_RECONNECT_DELAY = 60_000;

type PgClientConstructor = new (options: {
  connectionString?: string;
}) => OutboxNotificationClient;

type ClientHandler = (payload: any) => void;

interface ListenerConnection {
  readonly client: OutboxNotificationClient;
  readonly generation: number;
  readonly notificationHandler: ClientHandler;
  readonly errorHandler: ClientHandler;
  readonly endHandler: ClientHandler;
  closePromise: Promise<void> | null;
}

const nodeRequire = createRequire(__filename);

@Injectable()
export class OutboxListener implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxListener.name);
  private activeConnection: ListenerConnection | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private isShuttingDown = false;
  private connectInFlight: Promise<void> | null = null;
  private readonly pendingCloses = new Set<Promise<void>>();

  constructor(
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxOptions,
    @Inject(OutboxPoller)
    private readonly poller: Pick<OutboxPoller, 'requestPoll'>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.options.wakeup?.enabled) {
      if (this.options.polling?.enabled === false) {
        throw new OutboxWakeupUnavailableError(
          new Error('wakeup.enabled is false'),
        );
      }
      return;
    }

    try {
      await this.connect();
      this.reconnectAttempt = 0;
    } catch (error: unknown) {
      const err = this.toError(error);
      if (this.options.polling?.enabled === false) {
        throw new OutboxWakeupUnavailableError(err);
      }

      this.logger.warn(
        `Outbox LISTEN/NOTIFY initial connection unavailable; continuing with polling fallback: ${err.message}`,
      );
      this.scheduleReconnect();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.generation++;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const active = this.activeConnection;
    this.activeConnection = null;
    const activeClose = active
      ? this.closeConnection(active, 'shutdown')
      : Promise.resolve();
    const inFlight = this.connectInFlight;

    await Promise.all([activeClose, inFlight?.catch(() => undefined)]);
    await Promise.all([...this.pendingCloses]);
  }

  private async connect(): Promise<void> {
    if (this.connectInFlight) {
      return this.connectInFlight;
    }

    const task = this.connectOnce();
    this.connectInFlight = task;
    try {
      await task;
    } finally {
      if (this.connectInFlight === task) {
        this.connectInFlight = null;
      }
    }
  }

  private async connectOnce(): Promise<void> {
    if (this.isShuttingDown) return;

    const previous = this.activeConnection;
    if (previous) {
      this.activeConnection = null;
      this.generation++;
      await this.closeConnection(previous, 'replacement');
    }

    const generation = ++this.generation;
    const client = await this.createClient();
    if (!client) {
      throw new Error(
        'no PostgreSQL notification client is available; install "pg" or configure wakeup.clientFactory',
      );
    }

    if (this.isShuttingDown || generation !== this.generation) {
      await this.closeDetachedClient(client, 'stale connection attempt');
      return;
    }

    const channel = this.getChannel();
    const connection: ListenerConnection = {
      client,
      generation,
      notificationHandler: (notification) => {
        if (!this.isCurrent(connection)) return;
        if (notification.channel !== channel) return;
        this.poller.requestPoll();
      },
      errorHandler: (error) => {
        this.handleDisconnect(connection, 'error', this.toError(error));
      },
      endHandler: () => {
        this.handleDisconnect(connection, 'end');
      },
      closePromise: null,
    };

    client.on('notification', connection.notificationHandler);
    client.on('error', connection.errorHandler);
    client.on('end', connection.endHandler);
    this.activeConnection = connection;

    try {
      await client.connect();
      this.assertCurrent(connection);
      await client.query(`LISTEN ${this.quoteIdentifier(channel)}`);
      this.assertCurrent(connection);
    } catch (error: unknown) {
      if (this.activeConnection === connection) {
        this.activeConnection = null;
      }
      if (this.generation === generation) {
        this.generation++;
      }
      await this.closeConnection(connection, 'failed connection attempt');
      throw error;
    }
  }

  private async createClient(): Promise<OutboxNotificationClient | null> {
    const factory = this.options.wakeup?.clientFactory;
    if (factory) {
      return factory();
    }

    const Client = this.loadPgClient();
    if (!Client) return null;

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

  private handleDisconnect(
    connection: ListenerConnection,
    event: 'error' | 'end',
    error?: Error,
  ): void {
    if (!this.isCurrent(connection)) return;

    this.activeConnection = null;
    this.generation++;
    const detail = error ? `: ${error.message}` : '';
    this.logger.warn(`Outbox LISTEN/NOTIFY client ${event}${detail}`);

    void this.closeConnection(connection, `client ${event}`).then(() => {
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.reconnectTimer || this.connectInFlight) {
      return;
    }

    const attempt = this.reconnectAttempt + 1;
    const delay = this.getReconnectDelay(attempt);
    this.reconnectAttempt = attempt;
    this.logger.warn(
      `Outbox LISTEN/NOTIFY reconnect attempt ${attempt} scheduled in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      await this.connect();
      if (this.isShuttingDown) return;
      this.logger.log('Outbox LISTEN/NOTIFY connection restored');
      this.reconnectAttempt = 0;
    } catch (error: unknown) {
      const err = this.toError(error);
      this.logger.warn(`Outbox LISTEN/NOTIFY reconnect failed: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  private getReconnectDelay(attempt: number): number {
    const base = this.options.wakeup?.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
    const exponent = Math.min(attempt - 1, 30);
    return Math.min(base * 2 ** exponent, MAX_RECONNECT_DELAY);
  }

  private isCurrent(connection: ListenerConnection): boolean {
    return (
      !this.isShuttingDown &&
      this.activeConnection === connection &&
      this.generation === connection.generation
    );
  }

  private assertCurrent(connection: ListenerConnection): void {
    if (!this.isCurrent(connection)) {
      throw new Error('PostgreSQL notification connection became stale');
    }
  }

  private closeConnection(
    connection: ListenerConnection,
    reason: string,
  ): Promise<void> {
    if (connection.closePromise) return connection.closePromise;

    this.detachHandlers(connection);
    const close = this.closeDetachedClient(connection.client, reason).finally(
      () => {
        this.pendingCloses.delete(close);
      },
    );
    connection.closePromise = close;
    this.pendingCloses.add(close);
    return close;
  }

  private detachHandlers(connection: ListenerConnection): void {
    const remove =
      connection.client.off?.bind(connection.client) ??
      connection.client.removeListener?.bind(connection.client);
    if (!remove) return;

    try {
      remove('notification', connection.notificationHandler);
      remove('error', connection.errorHandler);
      remove('end', connection.endHandler);
    } catch (error: unknown) {
      this.logger.warn(
        `Outbox LISTEN/NOTIFY listener cleanup failed: ${this.toError(error).message}`,
      );
    }
  }

  private async closeDetachedClient(
    client: OutboxNotificationClient,
    reason: string,
  ): Promise<void> {
    try {
      await client.end();
    } catch (error: unknown) {
      this.logger.warn(
        `Outbox LISTEN/NOTIFY client close failed during ${reason}: ${this.toError(error).message}`,
      );
    }
  }

  private getChannel(): string {
    return this.options.wakeup?.channel ?? DEFAULT_WAKEUP_CHANNEL;
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
