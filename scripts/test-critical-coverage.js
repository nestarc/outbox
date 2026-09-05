#!/usr/bin/env node
// Run the complete unit coverage gate and bind its reports to the actual checkout
// and installed runtime, including local changes and CI matrix overrides.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { installedVersion } = require('./assert-installed-versions');

const root = path.resolve(__dirname, '..');
const coverage = path.join(root, 'coverage');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function inputs() {
  const names = git('ls-files', '-c', '-o', '--exclude-standard', '-z').split(
    '\0',
  );
  return Object.fromEntries(
    [...new Set(names)]
      .sort()
      .filter((name) =>
        /^(src\/|test\/|scripts\/|\.github\/workflows\/|package(?:-lock)?\.json$|jest\.config\.ts$|tsconfig.*\.json$)/.test(
          name,
        ),
      )
      .map((name) => [
        name,
        fs.existsSync(path.join(root, name))
          ? sha256(fs.readFileSync(path.join(root, name)))
          : null,
      ]),
  );
}

function main() {
  fs.rmSync(coverage, { recursive: true, force: true });
  // This command always runs all unit suites. Use npm test for filtered debugging.
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--runInBand')) {
    throw new Error(
      'Coverage evidence requires the full suite; only --runInBand is supported',
    );
  }
  const startedAt = new Date().toISOString();
  const commit = git('rev-parse', 'HEAD');
  const sourceInputs = inputs();
  const packages = Object.fromEntries(
    [
      '@nestjs/common',
      '@nestjs/core',
      '@nestjs/schedule',
      '@nestjs/testing',
      'prisma',
      '@prisma/client',
      '@prisma/adapter-pg',
      'pg',
      'jest',
      'ts-jest',
      'typescript',
    ].map((name) => [name, installedVersion(root, name)]),
  );
  const jestArgs = [
    require.resolve('jest/bin/jest'),
    '--selectProjects',
    'unit',
    '--coverage',
    '--runInBand',
    '--json',
    '--outputFile',
    'coverage/test-results.json',
  ];
  const result = spawnSync(process.execPath, jestArgs, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return;
  }
  if (
    commit !== git('rev-parse', 'HEAD') ||
    JSON.stringify(sourceInputs) !== JSON.stringify(inputs())
  ) {
    throw new Error('Coverage inputs changed during testing; rerun the gate');
  }
  const reports = Object.fromEntries(
    [
      'coverage-final.json',
      'coverage-summary.json',
      'lcov.info',
      'test-results.json',
    ].map((name) => [name, sha256(fs.readFileSync(path.join(coverage, name)))]),
  );
  const evidence = {
    schemaVersion: 1,
    scope:
      'unit coverage only; PostgreSQL/concurrency E2E is a separate required gate',
    startedAt,
    completedAt: new Date().toISOString(),
    git: {
      commit,
      tree: git('rev-parse', 'HEAD^{tree}'),
      status: git('status', '--porcelain'),
      inputSha256: sha256(JSON.stringify(sourceInputs)),
      inputs: sourceInputs,
    },
    runtime: {
      node: process.version,
      npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
      platform: process.platform,
      arch: process.arch,
      packages,
    },
    ci: {
      workflow: process.env.GITHUB_WORKFLOW || null,
      event: process.env.GITHUB_EVENT_NAME || null,
      sha: process.env.GITHUB_SHA || null,
      ref: process.env.GITHUB_REF || null,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    },
    command: [process.execPath, ...jestArgs],
    reports,
  };
  fs.writeFileSync(
    path.join(coverage, 'metadata.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(
    `Coverage evidence: ${commit}, ${process.version}, Nest ${packages['@nestjs/core']}, Prisma ${packages.prisma}`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
