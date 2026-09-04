#!/usr/bin/env node
/**
 * Packs the current package and proves that an isolated consumer can install
 * and execute it with an exact modern NestJS / Prisma 7 tuple.
 *
 * `--nest12` selects the OUT-M14 NestJS 12 control. Before the public peer
 * decision is adopted, `--candidate-manifest` stages an otherwise identical
 * package with the proposed Node/NestJS/Schedule ranges so the candidate can
 * be proved without publishing an unsupported declaration.
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyArtifact } = require('./release-artifact');

const FIXTURE_DIRECTORY = path.join('test', 'modern-consumer', 'fixture');
const NEST12 = process.argv.includes('--nest12');
const CANDIDATE_MANIFEST = process.argv.includes('--candidate-manifest');
const NEST_VERSION = NEST12 ? '12.0.1' : '11.2.3';
const SCHEDULE_VERSION = NEST12 ? '12.0.1' : '5.0.1';
const EXACT_DEPENDENCIES = {
  '@nestjs/common': NEST_VERSION,
  '@nestjs/core': NEST_VERSION,
  '@nestjs/schedule': SCHEDULE_VERSION,
  '@nestjs/testing': NEST_VERSION,
  '@prisma/adapter-pg': '7.10.0',
  '@prisma/client': '7.10.0',
  pg: '8.20.0',
  prisma: '7.10.0',
  'reflect-metadata': '0.2.2',
  rxjs: '7.8.2',
};
const EXACT_DEV_DEPENDENCIES = {
  '@types/node': NEST12 ? '22.20.1' : '20.19.39',
  '@types/pg': '8.20.0',
  typescript: '5.9.3',
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
}

function strictInstallEnvironment(temporaryDirectory) {
  const env = { ...process.env };
  delete env.NPM_CONFIG_FORCE;
  delete env.NPM_CONFIG_LEGACY_PEER_DEPS;

  return {
    ...env,
    npm_config_cache: path.join(temporaryDirectory, 'npm-cache'),
    npm_config_force: 'false',
    npm_config_legacy_peer_deps: 'false',
    npm_config_strict_peer_deps: 'true',
  };
}

function stageCandidatePackage(workspaceDirectory, temporaryDirectory) {
  const candidateDirectory = path.join(temporaryDirectory, 'candidate-package');
  fs.mkdirSync(candidateDirectory, { recursive: true });
  for (const entry of ['dist', 'src', 'README.md', 'LICENSE']) {
    fs.cpSync(
      path.join(workspaceDirectory, entry),
      path.join(candidateDirectory, entry),
      { recursive: true },
    );
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.join(workspaceDirectory, 'package.json'), 'utf8'),
  );
  manifest.engines.node = '>=22.0.0';
  manifest.peerDependencies['@nestjs/common'] = '^10.0.0 || ^11.0.0 || ^12.0.0';
  manifest.peerDependencies['@nestjs/core'] = '^10.0.0 || ^11.0.0 || ^12.0.0';
  manifest.peerDependencies['@nestjs/schedule'] = '^4.0.0 || ^5.0.0 || ^12.0.0';
  fs.writeFileSync(
    path.join(candidateDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return candidateDirectory;
}

function packPackage(workspaceDirectory, temporaryDirectory) {
  if (process.env.OUTBOX_TGZ || process.env.OUTBOX_TGZ_METADATA) {
    if (CANDIDATE_MANIFEST) {
      throw new Error('candidate manifest cannot reuse a release artifact');
    }
    if (!process.env.OUTBOX_TGZ || !process.env.OUTBOX_TGZ_METADATA) {
      throw new Error(
        'OUTBOX_TGZ and OUTBOX_TGZ_METADATA must be set together',
      );
    }
    const tarballPath = path.resolve(process.env.OUTBOX_TGZ);
    const metadata = verifyArtifact(
      tarballPath,
      path.resolve(process.env.OUTBOX_TGZ_METADATA),
    );
    return { path: tarballPath, integrity: metadata.integrity };
  }

  const packageDirectory = CANDIDATE_MANIFEST
    ? stageCandidatePackage(workspaceDirectory, temporaryDirectory)
    : workspaceDirectory;
  const output = execFileSync(
    'npm',
    [
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      temporaryDirectory,
    ],
    {
      cwd: packageDirectory,
      encoding: 'utf8',
      env: strictInstallEnvironment(temporaryDirectory),
    },
  );
  const packed = JSON.parse(output)[0];
  if (!packed?.filename || !packed?.integrity) {
    throw new Error('npm pack did not return filename and integrity metadata');
  }

  const tarballPath = path.join(temporaryDirectory, packed.filename);
  const computedIntegrity = `sha512-${crypto
    .createHash('sha512')
    .update(fs.readFileSync(tarballPath))
    .digest('base64')}`;
  if (computedIntegrity !== packed.integrity) {
    throw new Error(
      `npm pack integrity ${packed.integrity} does not match tarball bytes ${computedIntegrity}`,
    );
  }

  return {
    path: tarballPath,
    integrity: computedIntegrity,
  };
}

function packageManifestPath(consumerDirectory, packageName) {
  return path.join(
    consumerDirectory,
    'node_modules',
    ...packageName.split('/'),
    'package.json',
  );
}

function assertInstalledVersions(consumerDirectory, expectedOutboxVersion) {
  const expectedVersions = {
    '@nestarc/outbox': expectedOutboxVersion,
    ...EXACT_DEPENDENCIES,
    ...EXACT_DEV_DEPENDENCIES,
  };

  for (const [packageName, expectedVersion] of Object.entries(
    expectedVersions,
  )) {
    const manifest = JSON.parse(
      fs.readFileSync(
        packageManifestPath(consumerDirectory, packageName),
        'utf8',
      ),
    );
    if (manifest.version !== expectedVersion) {
      throw new Error(
        `Installed ${packageName}@${manifest.version}; expected ${expectedVersion}`,
      );
    }
  }
}

function assertPackedProvenance(
  consumerDirectory,
  expectedVersion,
  expectedIntegrity,
) {
  const lock = JSON.parse(
    fs.readFileSync(path.join(consumerDirectory, 'package-lock.json'), 'utf8'),
  );
  const entry = lock.packages?.['node_modules/@nestarc/outbox'];
  if (!entry) throw new Error('Packed Outbox lock entry is missing');
  if (entry.version !== expectedVersion) {
    throw new Error(
      `Packed Outbox lock version ${entry.version}; expected ${expectedVersion}`,
    );
  }
  if (entry.integrity !== expectedIntegrity) {
    throw new Error('Packed Outbox lock integrity does not match npm pack');
  }
  if (
    typeof entry.resolved !== 'string' ||
    !entry.resolved.startsWith('file:')
  ) {
    throw new Error('Packed Outbox must resolve from an explicit file tarball');
  }

  for (const [packageName, expectedDependencyVersion] of Object.entries({
    ...EXACT_DEPENDENCIES,
    ...EXACT_DEV_DEPENDENCIES,
  })) {
    const dependencyEntry = lock.packages?.[`node_modules/${packageName}`];
    if (!dependencyEntry) {
      throw new Error(`${packageName} lock entry is missing`);
    }
    if (dependencyEntry.version !== expectedDependencyVersion) {
      throw new Error(
        `${packageName} lock version ${dependencyEntry.version}; expected ${expectedDependencyVersion}`,
      );
    }
    if (
      typeof dependencyEntry.resolved !== 'string' ||
      !dependencyEntry.resolved.startsWith('https://registry.npmjs.org/')
    ) {
      throw new Error(`${packageName} must resolve from the npm registry`);
    }
    if (
      typeof dependencyEntry.integrity !== 'string' ||
      !dependencyEntry.integrity.startsWith('sha512-')
    ) {
      throw new Error(`${packageName} lock integrity is missing`);
    }
  }
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
    path.join(os.tmpdir(), 'nestarc-outbox-modern-consumer-'),
  );
  const consumerDirectory = path.join(temporaryDirectory, 'consumer');

  try {
    const packed = packPackage(workspaceDirectory, temporaryDirectory);
    fs.cpSync(
      path.join(workspaceDirectory, FIXTURE_DIRECTORY),
      consumerDirectory,
      { recursive: true },
    );

    const manifestPath = path.join(consumerDirectory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = {
      '@nestarc/outbox': `file:${packed.path}`,
      ...EXACT_DEPENDENCIES,
    };
    manifest.devDependencies = { ...EXACT_DEV_DEPENDENCIES };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const env = strictInstallEnvironment(temporaryDirectory);
    console.log(
      `[modern-consumer] Outbox ${expectedVersion}, NestJS ${NEST_VERSION}, Schedule ${SCHEDULE_VERSION}, Prisma 7.10.0${CANDIDATE_MANIFEST ? ' (candidate manifest)' : ''}`,
    );
    run('npm', ['install', '--strict-peer-deps', '--no-audit', '--no-fund'], {
      cwd: consumerDirectory,
      env,
    });
    assertInstalledVersions(consumerDirectory, expectedVersion);
    assertPackedProvenance(
      consumerDirectory,
      expectedVersion,
      packed.integrity,
    );
    run('npm', ['ls', '--depth=0'], { cwd: consumerDirectory, env });
    run('npm', ['run', 'prisma:generate'], { cwd: consumerDirectory, env });
    run('npm', ['run', 'typecheck'], { cwd: consumerDirectory, env });
    run('npm', ['run', 'build'], { cwd: consumerDirectory, env });
    run('npm', ['run', 'smoke'], { cwd: consumerDirectory, env });
    console.log(
      `[modern-consumer] strict packed PostgreSQL smoke passed (${packed.integrity})`,
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

module.exports = {
  EXACT_DEPENDENCIES,
  assertInstalledVersions,
  assertPackedProvenance,
  strictInstallEnvironment,
};
