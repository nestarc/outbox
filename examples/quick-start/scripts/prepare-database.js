const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL to the example PostgreSQL database first.');
}

const root = path.resolve(__dirname, '..');
for (const file of [
  path.join(root, 'prisma/create-business-tables.sql'),
  require.resolve('@nestarc/outbox/src/sql/create-outbox-table.sql'),
]) {
  execFileSync(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'db',
      'execute',
      '--file',
      file,
      '--schema',
      path.join(root, 'prisma/schema.prisma'),
    ],
    { cwd: root, env: process.env, stdio: 'inherit' },
  );
}
