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
