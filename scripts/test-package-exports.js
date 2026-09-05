#!/usr/bin/env node
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { packArtifact, verifyArtifact } = require('./release-artifact');

const FIXTURE_DIRECTORY = path.join(
  'test',
  'package-exports-consumer',
  'fixture',
);
const EXACT_DEPENDENCIES = {
  '@nestjs/common': '11.2.3',
  '@nestjs/core': '11.2.3',
  '@nestjs/schedule': '5.0.1',
  '@prisma/client': '7.10.0',
  'reflect-metadata': '0.2.2',
  rxjs: '7.8.2',
};
const EXACT_DEV_DEPENDENCIES = {
  '@types/node': '22.20.1',
  typescript: '5.9.3',
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
}

function installEnvironment(temporaryDirectory) {
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

function main() {
  const workspaceDirectory = path.resolve(__dirname, '..');
  const workspaceManifest = JSON.parse(
    fs.readFileSync(path.join(workspaceDirectory, 'package.json'), 'utf8'),
  );
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nestarc-outbox-package-exports-'),
  );
  const artifactDirectory = path.join(temporaryDirectory, 'artifact');
  const consumerDirectory = path.join(temporaryDirectory, 'consumer');

  try {
    let tarballPath;
    if (process.env.OUTBOX_TGZ || process.env.OUTBOX_TGZ_METADATA) {
      assert.ok(
        process.env.OUTBOX_TGZ && process.env.OUTBOX_TGZ_METADATA,
        'OUTBOX_TGZ and OUTBOX_TGZ_METADATA must be set together',
      );
      tarballPath = path.resolve(process.env.OUTBOX_TGZ);
      verifyArtifact(
        tarballPath,
        path.resolve(process.env.OUTBOX_TGZ_METADATA),
      );
    } else {
      packArtifact(artifactDirectory);
      tarballPath = path.join(artifactDirectory, 'package.tgz');
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

    const env = installEnvironment(temporaryDirectory);
    run('npm', ['install', '--strict-peer-deps', '--no-audit', '--no-fund'], {
      cwd: consumerDirectory,
      env,
    });

    const lock = JSON.parse(
      fs.readFileSync(
        path.join(consumerDirectory, 'package-lock.json'),
        'utf8',
      ),
    );
    assert.ok(
      lock.packages?.['node_modules/@nestarc/outbox'],
      'packed Outbox lock entry is missing',
    );
    assert.equal(
      lock.packages?.['node_modules/pg'],
      undefined,
      'optional pg must not be installed by the exports-only consumer',
    );
    run('npm', ['run', 'typecheck'], { cwd: consumerDirectory, env });
    run('npm', ['run', 'smoke'], { cwd: consumerDirectory, env });
    console.log(
      `[package-exports] root/types/two SQL exports passed without optional pg for ${workspaceManifest.name}@${workspaceManifest.version}`,
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
