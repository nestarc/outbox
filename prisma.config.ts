import { defineConfig } from 'prisma/config';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://test:test@localhost:5433/outbox_test';

export default defineConfig({
  schema: 'test/e2e/prisma/schema.prisma',
  datasource: {
    url: databaseUrl,
  },
});
