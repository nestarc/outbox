import {
  OutboxPoller,
  OutboxShutdownError,
  type OutboxStopOptions,
  type OutboxOptions,
  type OutboxRecord,
} from '@nestarc/outbox';

const options: OutboxOptions = {
  prisma: {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
  },
};

const recordId: OutboxRecord['id'] = '00000000-0000-0000-0000-000000000000';

const stopOptions: OutboxStopOptions = { timeoutMs: 1000 };
const stop: (options?: OutboxStopOptions) => Promise<void> =
  OutboxPoller.prototype.stop;

export { options, recordId, stop, stopOptions, OutboxShutdownError };
