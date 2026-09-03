#!/usr/bin/env node
/**
 * Packs the current package and proves that the declared Prisma 5 floor works
 * in an isolated Node 22 / NestJS 10 consumer against PostgreSQL.
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURE_DIRECTORY = path.join('test', 'prisma5-consumer', 'fixture');
const PRISMA_VERSION = process.argv.includes('--prisma6') ? '6.19.3' : '5.22.0';
const EXACT_DEPENDENCIES = {
  '@nestjs/common': '10.4.22',
  '@nestjs/core': '10.4.22',
  '@nestjs/schedule': '4.1.2',
  '@nestjs/testing': '10.4.22',
  '@prisma/client': PRISMA_VERSION,
  pg: '8.20.0',
  prisma: PRISMA_VERSION,
  'reflect-metadata': '0.2.2',
  rxjs: '7.8.2',
};
const EXACT_DEV_DEPENDENCIES = {
  '@types/node': '20.19.39',
  '@types/pg': '8.20.0',
  typescript: '5.9.3',
};

function strictInstallEnvironment(temporaryDirectory) {
  const env = { ...process.env };
  delete env.NPM_CONFIG_FORCE;
  delete env.NPM_CONFIG_LEGACY_PEER_DEPS;
  return {
    ...env,
    // This fixture drops its own outbox table; never inherit a caller DB URL.
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5433/outbox_test',
    OUTBOX_CONSUMER_PRISMA_VERSION: PRISMA_VERSION,
    npm_config_cache: path.join(temporaryDirectory, 'npm-cache'),
    npm_config_force: 'false',
    npm_config_legacy_peer_deps: 'false',
    npm_config_strict_peer_deps: 'true',
  };
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function packageManifestPath(consumerDirectory, packageName) {
  return path.join(
    consumerDirectory,
    'node_modules',
    ...packageName.split('/'),
    'package.json',
  );
}

function main() {
  const workspaceDirectory = path.resolve(__dirname, '..');
  const workspaceManifest = JSON.parse(
    fs.readFileSync(path.join(workspaceDirectory, 'package.json'), 'utf8'),
  );
  const expectedVersion = workspaceManifest.version;
  const prismaPeer = workspaceManifest.peerDependencies?.['@prisma/client'];
  if (prismaPeer !== '^5.0.0 || ^6.0.0 || ^7.0.0') {
    throw new Error(`Unexpected @prisma/client peer range: ${prismaPeer}`);
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      `nestarc-outbox-prisma${PRISMA_VERSION.split('.')[0]}-consumer-`,
    ),
  );
  const consumerDirectory = path.join(temporaryDirectory, 'consumer');
  const env = strictInstallEnvironment(temporaryDirectory);

  try {
    const packOutput = execFileSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        temporaryDirectory,
      ],
      { cwd: workspaceDirectory, encoding: 'utf8', env },
    );
    const packed = JSON.parse(packOutput)[0];
    if (!packed?.filename || !packed?.integrity) {
      throw new Error(
        'npm pack did not return filename and integrity metadata',
      );
    }
    const tarballPath = path.join(temporaryDirectory, packed.filename);
    const computedIntegrity = `sha512-${crypto
      .createHash('sha512')
      .update(fs.readFileSync(tarballPath))
      .digest('base64')}`;
    if (computedIntegrity !== packed.integrity) {
      throw new Error('packed tarball integrity does not match npm metadata');
    }

    fs.cpSync(
      path.join(workspaceDirectory, FIXTURE_DIRECTORY),
      consumerDirectory,
      { recursive: true },
    );
    const manifestPath = path.join(consumerDirectory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = {
      '@nestarc/outbox': `file:${tarballPath}`,
      ...EXACT_DEPENDENCIES,
    };
    manifest.devDependencies = { ...EXACT_DEV_DEPENDENCIES };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(
      `[legacy-consumer] Outbox ${expectedVersion}, NestJS 10.4.22, Prisma ${PRISMA_VERSION}`,
    );
    run('npm', ['install', '--strict-peer-deps', '--no-audit', '--no-fund'], {
      cwd: consumerDirectory,
      env,
    });

    for (const [packageName, expectedPackageVersion] of Object.entries({
      '@nestarc/outbox': expectedVersion,
      ...EXACT_DEPENDENCIES,
      ...EXACT_DEV_DEPENDENCIES,
    })) {
      const installed = JSON.parse(
        fs.readFileSync(
          packageManifestPath(consumerDirectory, packageName),
          'utf8',
        ),
      );
      if (installed.version !== expectedPackageVersion) {
        throw new Error(
          `Installed ${packageName}@${installed.version}; expected ${expectedPackageVersion}`,
        );
      }
    }

    const lock = JSON.parse(
      fs.readFileSync(
        path.join(consumerDirectory, 'package-lock.json'),
        'utf8',
      ),
    );
    const outboxEntry = lock.packages?.['node_modules/@nestarc/outbox'];
    if (
      outboxEntry?.version !== expectedVersion ||
      outboxEntry?.integrity !== computedIntegrity ||
      !outboxEntry?.resolved?.startsWith('file:')
    ) {
      throw new Error('packed Outbox lock provenance is invalid');
    }

    run('npm', ['ls', '--depth=0'], { cwd: consumerDirectory, env });
    run('npm', ['run', 'prisma:generate'], { cwd: consumerDirectory, env });
    run('npm', ['run', 'typecheck'], { cwd: consumerDirectory, env });
    run('npm', ['run', 'build'], { cwd: consumerDirectory, env });
    run('npm', ['run', 'smoke'], { cwd: consumerDirectory, env });
    console.log(
      `[legacy-consumer] Prisma ${PRISMA_VERSION} strict packed PostgreSQL smoke passed (${computedIntegrity})`,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = { EXACT_DEPENDENCIES, main };
