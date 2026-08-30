#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function main() {
  const workspaceDirectory = path.resolve(__dirname, '..');
  const prismaManifest = JSON.parse(
    fs.readFileSync(
      path.join(workspaceDirectory, 'node_modules', 'prisma', 'package.json'),
      'utf8',
    ),
  );
  const prismaMajor = Number(prismaManifest.version.split('.')[0]);
  const schema =
    prismaMajor >= 7
      ? 'test/e2e/prisma/schema.prisma'
      : 'test/e2e/prisma/schema.prisma6.prisma';
  const prismaCli = path.join(
    workspaceDirectory,
    'node_modules',
    'prisma',
    'build',
    'index.js',
  );

  console.log(
    `[prisma:generate] Prisma ${prismaManifest.version} using ${schema}`,
  );
  execFileSync(process.execPath, [prismaCli, 'generate', '--schema', schema], {
    cwd: workspaceDirectory,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://test:test@localhost:5433/outbox_test',
    },
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = { main };
