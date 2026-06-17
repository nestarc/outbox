import { OutboxListener } from '../src/outbox.listener';
import type { OutboxNotificationClient } from '../src/interfaces/outbox-wakeup.interface';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';
import type { OutboxPoller } from '../src/outbox.poller';

function createClient(): {
  client: jest.Mocked<OutboxNotificationClient>;
  handlers: Record<string, Array<(payload: any) => void>>;
} {
  const handlers: Record<string, Array<(payload: any) => void>> = {};
  const client: jest.Mocked<OutboxNotificationClient> = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((event: string, handler: (payload: any) => void) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
      return client;
    }),
  };

  return { client, handlers };
}

function createPoller(): jest.Mocked<Pick<OutboxPoller, 'poll'>> {
  return {
    poll: jest.fn().mockResolvedValue(undefined),
  };
}

describe('OutboxListener', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('should connect and LISTEN when wakeup is enabled', async () => {
    const { client } = createClient();
    const poller = createPoller();
    const options: OutboxOptions = {
      prisma: {},
      wakeup: {
        enabled: true,
        channel: 'outbox_custom',
        clientFactory: () => client,
      },
    };

    const listener = new OutboxListener(options, poller);
    await listener.onModuleInit();

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('LISTEN "outbox_custom"');
  });

  it('should trigger poll on matching notification', async () => {
    const { client, handlers } = createClient();
    const poller = createPoller();
    const options: OutboxOptions = {
      prisma: {},
      wakeup: {
        enabled: true,
        channel: 'outbox_custom',
        clientFactory: () => client,
      },
    };

    const listener = new OutboxListener(options, poller);
    await listener.onModuleInit();

    handlers.notification[0]({ channel: 'outbox_custom', payload: 'order.created' });

    expect(poller.poll).toHaveBeenCalledTimes(1);
  });

  it('should escape notification channel identifiers', async () => {
    const { client } = createClient();
    const poller = createPoller();
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          channel: 'outbox"custom',
          clientFactory: () => client,
        },
      },
      poller,
    );

    await listener.onModuleInit();

    expect(client.query).toHaveBeenCalledWith('LISTEN "outbox""custom"');
  });

  it('should isolate poll failures triggered by notifications', async () => {
    const { client, handlers } = createClient();
    const poller = createPoller();
    poller.poll.mockRejectedValue(new Error('poll failed'));
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          channel: 'outbox_custom',
          clientFactory: () => client,
        },
      },
      poller,
    );

    await listener.onModuleInit();
    handlers.notification[0]({ channel: 'outbox_custom' });
    await Promise.resolve();

    expect(poller.poll).toHaveBeenCalledTimes(1);
  });

  it('should ignore notifications from other channels', async () => {
    const { client, handlers } = createClient();
    const poller = createPoller();
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          channel: 'outbox_custom',
          clientFactory: () => client,
        },
      },
      poller,
    );
    await listener.onModuleInit();

    handlers.notification[0]({ channel: 'other_channel', payload: 'event' });

    expect(poller.poll).not.toHaveBeenCalled();
  });

  it('should not connect when wakeup is disabled', async () => {
    const { client } = createClient();
    const poller = createPoller();
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: false,
          clientFactory: () => client,
        },
      },
      poller,
    );

    await listener.onModuleInit();

    expect(client.connect).not.toHaveBeenCalled();
  });

  it('should fall back to polling when pg is unavailable and no client factory exists', async () => {
    const poller = createPoller();
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: { enabled: true },
      },
      poller,
    );

    await expect(listener.onModuleInit()).resolves.toBeUndefined();
  });

  it('should reconnect after client errors', async () => {
    jest.useFakeTimers();
    const first = createClient();
    const second = createClient();
    const poller = createPoller();
    const clientFactory = jest
      .fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          channel: 'outbox_custom',
          reconnectDelay: 50,
          clientFactory,
        },
      },
      poller,
    );

    await listener.onModuleInit();
    first.handlers.error[0](new Error('connection dropped'));
    await jest.advanceTimersByTimeAsync(50);

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(second.client.connect).toHaveBeenCalledTimes(1);
    expect(second.client.query).toHaveBeenCalledWith('LISTEN "outbox_custom"');
  });

  it('should not schedule duplicate reconnect timers', async () => {
    jest.useFakeTimers();
    const first = createClient();
    const second = createClient();
    const poller = createPoller();
    const clientFactory = jest
      .fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client);
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          reconnectDelay: 50,
          clientFactory,
        },
      },
      poller,
    );

    await listener.onModuleInit();
    first.handlers.error[0](new Error('first'));
    first.handlers.error[0](new Error('second'));
    await jest.advanceTimersByTimeAsync(50);

    expect(clientFactory).toHaveBeenCalledTimes(2);
  });

  it('should cancel a pending reconnect timer on shutdown', async () => {
    jest.useFakeTimers();
    const { client, handlers } = createClient();
    const poller = createPoller();
    const clientFactory = jest.fn().mockReturnValue(client);
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          reconnectDelay: 50,
          clientFactory,
        },
      },
      poller,
    );

    await listener.onModuleInit();
    handlers.error[0](new Error('connection dropped'));
    await listener.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(50);

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('should reschedule when reconnect fails', async () => {
    jest.useFakeTimers();
    const first = createClient();
    const poller = createPoller();
    const clientFactory = jest
      .fn()
      .mockReturnValueOnce(first.client)
      .mockRejectedValueOnce(new Error('still down'));
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          reconnectDelay: 50,
          clientFactory,
        },
      },
      poller,
    );

    await listener.onModuleInit();
    first.handlers.error[0](new Error('connection dropped'));
    await jest.advanceTimersByTimeAsync(50);

    expect(clientFactory).toHaveBeenCalledTimes(2);
    await listener.onApplicationShutdown();
  });

  it('should close the notification client on shutdown', async () => {
    const { client } = createClient();
    const poller = createPoller();
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          clientFactory: () => client,
        },
      },
      poller,
    );

    await listener.onModuleInit();
    await listener.onApplicationShutdown();

    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
