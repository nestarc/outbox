import { OutboxListener } from '../src/outbox.listener';
import { OutboxWakeupUnavailableError } from '../src';
import type { OutboxNotificationClient } from '../src/interfaces/outbox-wakeup.interface';
import type { OutboxOptions } from '../src/interfaces/outbox-options.interface';
import { OutboxPoller } from '../src/outbox.poller';

function createClient(supportsListenerRemoval = false): {
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

  if (supportsListenerRemoval) {
    client.removeListener = jest.fn(
      (event: string, handler: (payload: any) => void) => {
        const index = handlers[event]?.indexOf(handler) ?? -1;
        if (index >= 0) handlers[event].splice(index, 1);
        return client;
      },
    );
  }

  return { client, handlers };
}

function createPoller(): jest.Mocked<Pick<OutboxPoller, 'requestPoll'>> {
  return {
    requestPoll: jest.fn(),
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

    handlers.notification[0]({
      channel: 'outbox_custom',
      payload: 'order.created',
    });

    expect(poller.requestPoll).toHaveBeenCalledTimes(1);
  });

  it('coalesces a notification burst through the poll coordinator', async () => {
    const { client, handlers } = createClient();
    let reportFirstQueryStarted!: () => void;
    const firstQueryStarted = new Promise<void>((resolve) => {
      reportFirstQueryStarted = resolve;
    });
    let releaseFirstQuery!: () => void;
    const firstQueryBarrier = new Promise<void>((resolve) => {
      releaseFirstQuery = resolve;
    });
    let activeQueries = 0;
    let maxActiveQueries = 0;
    const prisma = {
      $queryRaw: jest.fn().mockImplementation(async () => {
        activeQueries++;
        maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
        try {
          if (prisma.$queryRaw.mock.calls.length === 1) {
            reportFirstQueryStarted();
            await firstQueryBarrier;
          }
          return [];
        } finally {
          activeQueries--;
        }
      }),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const options: OutboxOptions = {
      prisma,
      polling: { enabled: false },
      wakeup: {
        enabled: true,
        channel: 'outbox_custom',
        clientFactory: () => client,
      },
    };
    const poller = new OutboxPoller(
      options,
      { dispatch: jest.fn().mockResolvedValue(undefined) },
      {
        getHandlers: jest.fn().mockReturnValue([]),
        getRegisteredEventTypes: jest.fn().mockReturnValue([]),
      } as any,
      {
        addInterval: jest.fn(),
        deleteInterval: jest.fn(),
      } as any,
    );
    const listener = new OutboxListener(options, poller);
    await listener.onModuleInit();

    handlers.notification[0]({ channel: 'outbox_custom' });
    await firstQueryStarted;
    for (let i = 0; i < 100; i++) {
      handlers.notification[0]({ channel: 'outbox_custom' });
    }
    const completion = poller.poll();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    releaseFirstQuery();
    await completion;

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(maxActiveQueries).toBe(1);
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

  it('should delegate notification failure isolation to the poller', async () => {
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
    handlers.notification[0]({ channel: 'outbox_custom' });

    expect(poller.requestPoll).toHaveBeenCalledTimes(1);
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

    expect(poller.requestPoll).not.toHaveBeenCalled();
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

  it('should fail fast when both polling and wakeup are disabled', async () => {
    const listener = new OutboxListener(
      {
        prisma: {},
        polling: { enabled: false },
        wakeup: { enabled: false },
      },
      createPoller(),
    );

    await expect(listener.onModuleInit()).rejects.toMatchObject({
      name: 'OutboxWakeupUnavailableError',
      code: 'OUTBOX_WAKEUP_UNAVAILABLE',
      cause: expect.objectContaining({ message: 'wakeup.enabled is false' }),
    } satisfies Partial<OutboxWakeupUnavailableError>);
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
    jest.spyOn(listener as any, 'loadPgClient').mockReturnValue(null);

    await expect(listener.onModuleInit()).resolves.toBeUndefined();
  });

  it('should degrade to polling when the initial wakeup connection fails', async () => {
    jest.useFakeTimers();
    const { client } = createClient();
    client.connect.mockRejectedValueOnce(new Error('database unavailable'));
    const listener = new OutboxListener(
      {
        prisma: {},
        polling: { enabled: true },
        wakeup: {
          enabled: true,
          reconnectDelay: 50,
          clientFactory: () => client,
        },
      },
      createPoller(),
    );

    await expect(listener.onModuleInit()).resolves.toBeUndefined();
    expect(client.end).toHaveBeenCalledTimes(1);
    await listener.onApplicationShutdown();
  });

  it('should degrade to polling and close the client when the initial LISTEN query fails', async () => {
    jest.useFakeTimers();
    const { client } = createClient();
    client.query.mockRejectedValueOnce(new Error('LISTEN denied'));
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          reconnectDelay: 50,
          clientFactory: () => client,
        },
      },
      createPoller(),
    );

    await expect(listener.onModuleInit()).resolves.toBeUndefined();
    expect(client.end).toHaveBeenCalledTimes(1);
    await listener.onApplicationShutdown();
  });

  it('should fail fast with a stable typed error when polling is disabled and wakeup is unavailable', async () => {
    jest.useFakeTimers();
    const { client } = createClient();
    client.connect.mockRejectedValueOnce(new Error('database unavailable'));
    const listener = new OutboxListener(
      {
        prisma: {},
        polling: { enabled: false },
        wakeup: {
          enabled: true,
          reconnectDelay: 50,
          clientFactory: () => client,
        },
      },
      createPoller(),
    );

    await expect(listener.onModuleInit()).rejects.toMatchObject({
      name: 'OutboxWakeupUnavailableError',
      code: 'OUTBOX_WAKEUP_UNAVAILABLE',
      cause: expect.objectContaining({ message: 'database unavailable' }),
    } satisfies Partial<OutboxWakeupUnavailableError>);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
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

  it('should close the old client before reconnecting', async () => {
    jest.useFakeTimers();
    const first = createClient();
    const second = createClient();
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
      createPoller(),
    );

    await listener.onModuleInit();
    first.handlers.error[0](new Error('connection dropped'));
    await jest.advanceTimersByTimeAsync(50);

    expect(first.client.end).toHaveBeenCalledTimes(1);
    expect(first.client.end.mock.invocationCallOrder[0]).toBeLessThan(
      second.client.connect.mock.invocationCallOrder[0],
    );
    await listener.onApplicationShutdown();
  });

  it('should remove old client listeners when the transport supports removal', async () => {
    jest.useFakeTimers();
    const first = createClient(true);
    const second = createClient();
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          reconnectDelay: 50,
          clientFactory: jest
            .fn()
            .mockReturnValueOnce(first.client)
            .mockReturnValueOnce(second.client),
        },
      },
      createPoller(),
    );

    await listener.onModuleInit();
    const errorHandler = first.handlers.error[0];
    errorHandler(new Error('connection dropped'));
    await jest.advanceTimersByTimeAsync(50);

    expect(first.client.removeListener).toHaveBeenCalledTimes(3);
    expect(first.handlers.notification).toHaveLength(0);
    expect(first.handlers.error).toHaveLength(0);
    expect(first.handlers.end).toHaveLength(0);
    await listener.onApplicationShutdown();
  });

  it('should ignore stale callbacks when the transport cannot remove listeners', async () => {
    jest.useFakeTimers();
    const first = createClient();
    const second = createClient();
    const third = createClient();
    const poller = createPoller();
    const clientFactory = jest
      .fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(second.client)
      .mockReturnValueOnce(third.client);
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
    const staleError = first.handlers.error[0];
    const staleNotification = first.handlers.notification[0];
    staleError(new Error('connection dropped'));
    await jest.advanceTimersByTimeAsync(50);

    staleError(new Error('stale error'));
    staleNotification({ channel: 'outbox_custom' });
    await jest.advanceTimersByTimeAsync(500);

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(first.client.end).toHaveBeenCalledTimes(1);
    expect(poller.requestPoll).not.toHaveBeenCalled();
    await listener.onApplicationShutdown();
  });

  it('should reconnect after an unexpected client end', async () => {
    jest.useFakeTimers();
    const first = createClient();
    const second = createClient();
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
      createPoller(),
    );

    await listener.onModuleInit();
    first.handlers.end[0](undefined);
    await jest.advanceTimersByTimeAsync(50);

    expect(first.client.end).toHaveBeenCalledTimes(1);
    expect(second.client.query).toHaveBeenCalledTimes(1);
    await listener.onApplicationShutdown();
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

  it('should exponentially back off consecutive reconnect failures', async () => {
    jest.useFakeTimers();
    const first = createClient();
    const failedReconnect = createClient();
    failedReconnect.client.connect.mockRejectedValueOnce(
      new Error('still down'),
    );
    const recovered = createClient();
    const clientFactory = jest
      .fn()
      .mockReturnValueOnce(first.client)
      .mockReturnValueOnce(failedReconnect.client)
      .mockReturnValueOnce(recovered.client);
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          reconnectDelay: 50,
          clientFactory,
        },
      },
      createPoller(),
    );

    await listener.onModuleInit();
    first.handlers.error[0](new Error('connection dropped'));
    await jest.advanceTimersByTimeAsync(50);
    expect(clientFactory).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(99);
    expect(clientFactory).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(clientFactory).toHaveBeenCalledTimes(3);
    expect(recovered.client.query).toHaveBeenCalledTimes(1);
    await listener.onApplicationShutdown();
  });

  it('should close a client created during shutdown without connecting it', async () => {
    let resolveClient!: (client: OutboxNotificationClient) => void;
    const pendingClient = new Promise<OutboxNotificationClient>((resolve) => {
      resolveClient = resolve;
    });
    const { client } = createClient();
    const listener = new OutboxListener(
      {
        prisma: {},
        wakeup: {
          enabled: true,
          clientFactory: () => pendingClient,
        },
      },
      createPoller(),
    );

    const initialization = listener.onModuleInit();
    const shutdown = listener.onApplicationShutdown();
    resolveClient(client);
    await Promise.all([initialization, shutdown]);

    expect(client.connect).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
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
