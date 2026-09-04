import type { OutboxOptions, OutboxRecord } from '@nestarc/outbox';

const options: OutboxOptions = {
  prisma: {
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
  },
};

const recordId: OutboxRecord['id'] = '00000000-0000-0000-0000-000000000000';

export { options, recordId };
