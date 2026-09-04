#!/usr/bin/env node
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packArtifact, verifyArtifact } = require('./release-artifact');

// The same Prisma engine tuple isolates the optional pg variable. Prisma 7
// uses pg through its adapter and therefore cannot prove the absent boundary.
const dependencies = {
  '@nestjs/common': '11.2.3',
  '@nestjs/core': '11.2.3',
  '@nestjs/schedule': '5.0.1',
  '@nestjs/testing': '11.2.3',
  '@prisma/client': '5.22.0',
  prisma: '5.22.0',
  'reflect-metadata': '0.2.2',
  rxjs: '7.8.2',
};
const devDependencies = { '@types/node': '22.20.1', typescript: '5.9.3' };

function run(args, cwd, env) {
  execFileSync('npm', args, { cwd, env, stdio: 'inherit' });
}

function extract(readme, name, language) {
  const start = `<!-- packed-example:${name}:start -->`;
  const end = `<!-- packed-example:${name}:end -->`;
  assert.equal(readme.split(start).length, 2, `missing/duplicate ${name}`);
  assert.equal(readme.split(end).length, 2, `missing/duplicate ${name} end`);
  const fragment = readme.split(start)[1].split(end)[0].trim();
  const fence = '```';
  assert.ok(fragment.startsWith(`${fence}${language}\n`));
  assert.ok(fragment.endsWith(fence));
  return fragment
    .slice(fence.length + language.length + 1, -fence.length)
    .trim();
}

function writeExamples(consumer) {
  const readme = fs.readFileSync(
    path.join(consumer, 'node_modules/@nestarc/outbox/README.md'),
    'utf8',
  );
  const prefixes = {
    local:
      "import { Module } from '@nestjs/common';\nimport { PrismaModule, PrismaService, EmailService } from './support';\nimport { OrderService } from './emit';\nimport { OrderNotificationListener } from './handler';",
    event: '',
    'tenant-provider': '',
    emit: "import { Injectable } from '@nestjs/common';\nimport { PrismaService, CreateOrderDto } from './support';\nimport { OrderCreatedEvent } from './event';",
    handler:
      "import { Injectable } from '@nestjs/common';\nimport { EmailService } from './support';\nimport { OrderCreatedEvent } from './event';",
    publisher:
      "import { Injectable } from '@nestjs/common';\nimport { KafkaProducer } from './support';",
    async:
      "import { OutboxModule } from '@nestarc/outbox';\nimport { PrismaModule, PrismaService, ConfigModule, ConfigService, TenantContextModule, RequestTenantProvider, KafkaModule } from './support';\nimport { KafkaTransport } from './publisher';\nexport const registration =",
    tenant:
      "import { OutboxModule } from '@nestarc/outbox';\nimport { PrismaService, TenantContextProvider } from './support';\nexport const registration =",
    wakeup:
      "import { OutboxModule } from '@nestarc/outbox';\nimport { PrismaService } from './support';\nexport const registration =",
  };
  for (const [name, prefix] of Object.entries(prefixes)) {
    fs.writeFileSync(
      path.join(consumer, 'src', `${name}.ts`),
      `${prefix}\n${extract(readme, name, 'typescript')}\n`,
    );
  }
  // Check the public paths used in the actual README commands. Execute those
  // assets intact with Prisma CLI below (DO blocks must not be split on ';').
  for (const [name, asset] of [
    ['sql-create', 'create-outbox-table.sql'],
    ['sql-upgrade', 'upgrade-to-current.sql'],
  ]) {
    assert.ok(
      extract(readme, name, 'bash').includes(
        `require.resolve('@nestarc/outbox/src/sql/${asset}')`,
      ),
    );
  }
}

function main() {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'outbox-packed-examples-'),
  );
  try {
    let tgz = process.env.OUTBOX_TGZ;
    let metadata = process.env.OUTBOX_TGZ_METADATA;
    if (tgz || metadata) {
      assert.ok(
        tgz && metadata,
        'OUTBOX_TGZ and OUTBOX_TGZ_METADATA must be set together',
      );
      tgz = path.resolve(tgz);
      metadata = path.resolve(metadata);
    } else {
      packArtifact(path.join(temp, 'artifact'));
      tgz = path.join(temp, 'artifact/package.tgz');
      metadata = path.join(temp, 'artifact/metadata.json');
    }
    const artifact = verifyArtifact(tgz, metadata);
    for (const withPg of [false, true]) {
      const consumer = path.join(temp, withPg ? 'with-pg' : 'without-pg');
      fs.cpSync(path.join(root, 'test/packed-examples/fixture'), consumer, {
        recursive: true,
      });
      const exact = { ...dependencies, ...(withPg ? { pg: '8.20.0' } : {}) };
      const manifestPath = path.join(consumer, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.dependencies = { '@nestarc/outbox': `file:${tgz}`, ...exact };
      manifest.devDependencies = devDependencies;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const env = { ...process.env };
      delete env.NODE_PATH;
      delete env.NPM_CONFIG_FORCE;
      delete env.NPM_CONFIG_LEGACY_PEER_DEPS;
      Object.assign(env, {
        // Explicit disposable endpoint; never inherit DATABASE_URL.
        DATABASE_URL: 'postgresql://test:test@127.0.0.1:5433/outbox_test',
        OUTBOX_EXAMPLES_WITH_PG: String(withPg),
        npm_config_cache: path.join(temp, 'npm-cache'),
        npm_config_force: 'false',
        npm_config_legacy_peer_deps: 'false',
        npm_config_strict_peer_deps: 'true',
      });
      console.log(
        `[packed-examples] pg ${withPg ? 'present' : 'absent'}, ${artifact.integrity}`,
      );
      run(
        ['install', '--strict-peer-deps', '--no-audit', '--no-fund'],
        consumer,
        env,
      );
      const lock = JSON.parse(
        fs.readFileSync(path.join(consumer, 'package-lock.json'), 'utf8'),
      );
      const entry = lock.packages['node_modules/@nestarc/outbox'];
      assert.equal(entry.integrity, artifact.integrity);
      assert.ok(entry.resolved.startsWith('file:'));
      for (const [name, version] of Object.entries({
        ...exact,
        ...devDependencies,
      })) {
        assert.equal(
          lock.packages[`node_modules/${name}`]?.version,
          version,
          name,
        );
      }
      if (!withPg) {
        assert.ok(
          !Object.keys(lock.packages).some((name) =>
            /(^|\/)node_modules\/(pg|@types\/pg)$/.test(name),
          ),
          'pg and @types/pg must be absent throughout the dependency graph',
        );
      }
      writeExamples(consumer);
      run(['run', 'generate'], consumer, env);
      run(['run', 'typecheck'], consumer, env);
      run(['run', 'build'], consumer, env);
      for (const asset of [
        'create-outbox-table.sql',
        'upgrade-to-current.sql',
        'upgrade-to-current.sql',
      ]) {
        const sql = execFileSync(
          process.execPath,
          ['-p', `require.resolve('@nestarc/outbox/src/sql/${asset}')`],
          { cwd: consumer, encoding: 'utf8' },
        ).trim();
        run(
          [
            'exec',
            '--no',
            '--',
            'prisma',
            'db',
            'execute',
            '--file',
            sql,
            '--schema',
            'prisma/schema.prisma',
          ],
          consumer,
          env,
        );
      }
      run(['run', 'smoke'], consumer, env);
    }
    verifyArtifact(tgz, metadata);
    console.log(
      '[packed-examples] README compile/DI/PostgreSQL/optional pg boundaries PASS',
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
