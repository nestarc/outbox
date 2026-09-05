#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decodeStatements, parseNpmView } = require('./release-artifact');

// Exact-version npm view changed from an object/scalar to a singleton array
// in npm 12. Accept either shape, but never select from ambiguous results.
const registryDist = {
  integrity: 'sha512-example',
  attestations: {
    provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
  },
};
for (const value of [registryDist, registryDist.integrity]) {
  assert.deepEqual(parseNpmView(JSON.stringify(value)), value);
  assert.deepEqual(parseNpmView(JSON.stringify([value])), value);
}
assert.throws(() => parseNpmView('[]'), /exactly one/);
assert.throws(() => parseNpmView('[{}, {}]'), /exactly one/);
assert.throws(() => parseNpmView('{invalid'), SyntaxError);

const workflowPath = path.resolve(
  __dirname,
  '..',
  '.github',
  'workflows',
  'release.yml',
);
const workflow = fs.readFileSync(workflowPath, 'utf8');

function job(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker, workflow.indexOf('jobs:\n'));
  assert.notEqual(start, -1, `missing ${name} job`);
  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-z][a-z0-9-]*:\n/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

const actionReferences = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)].map(
  (match) => match[1],
);
assert.ok(
  actionReferences.length > 0,
  'release workflow must use reviewed actions',
);
for (const reference of actionReferences) {
  assert.match(
    reference,
    /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/,
    `action must be pinned to a full commit SHA: ${reference}`,
  );
}

assert.match(workflow, /workflow_dispatch:\n\nconcurrency:/);
assert.doesNotMatch(workflow, /dry_run:\s*\n[\s\S]*default:\s*false/);
assert.match(workflow, /git merge-base --is-ancestor/);
assert.match(workflow, /main:refs\/remotes\/origin\/main/);

const realPublishCommands = workflow
  .split('\n')
  .filter(
    (line) => line.includes('run: npm publish') && !line.includes('--dry-run'),
  );
assert.equal(realPublishCommands.length, 1, 'exactly one real publish command');

const verify = job('verify');
const buildAndTest = job('build-and-test');
const compatibilityNode24 = job('compatibility-node24');
const manualDryRun = job('manual-dry-run');
const publishNpm = job('publish-npm');
const verifyPublished = job('verify-published');
const githubRelease = job('github-release');

for (const [name, definition] of [
  ['verify', verify],
  ['build-and-test', buildAndTest],
  ['compatibility-node24', compatibilityNode24],
  ['manual-dry-run', manualDryRun],
]) {
  assert.match(definition, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(definition, /id-token: write|contents: write/);
  if (name === 'manual-dry-run') {
    assert.match(definition, /if: github\.event_name == 'workflow_dispatch'/);
    assert.match(
      definition,
      /npm publish "\$OUTBOX_TGZ" --ignore-scripts --access public --dry-run/,
    );
  }
}

assert.match(buildAndTest, /node-version: '22'/);
assert.match(buildAndTest, /npm run test:nest12-consumer/);
assert.match(buildAndTest, /node scripts\/test-package-exports\.js/);
assert.match(buildAndTest, /npm run audit:production/);
assert.match(buildAndTest, /run: npm run test:cov/);
assert.ok(
  buildAndTest.indexOf('run: npm run test:cov') <
    buildAndTest.indexOf('node scripts/release-artifact.js pack'),
  'critical coverage must pass before the release candidate is packed',
);
assert.match(
  buildAndTest,
  /name: coverage-\$\{\{ github\.sha \}\}-node22-locked-runtime-\$\{\{ github\.run_attempt \}\}/,
);
const ci = fs.readFileSync(
  path.resolve(__dirname, '..', '.github/workflows/ci.yml'),
  'utf8',
);
assert.match(ci, /run: npm run test:cov/);
assert.match(
  ci,
  /name: coverage-\$\{\{ github\.sha \}\}-node\$\{\{ matrix\.node \}\}-nest\$\{\{ matrix\.nestjs \}\}-prisma\$\{\{ matrix\.prisma \}\}-\$\{\{ github\.run_attempt \}\}/,
);
for (const definition of [ci, buildAndTest]) {
  assert.match(definition, /run: npm run test:e2e/);
  assert.doesNotMatch(
    definition,
    /continue-on-error: true[\s\S]*run: npm run test:cov/,
  );
}
assert.equal(
  require('../package.json').scripts['test:cov'],
  'node scripts/test-critical-coverage.js',
);
assert.match(compatibilityNode24, /node-version: '24'/);
assert.match(
  compatibilityNode24,
  /node scripts\/test-modern-consumer\.js --nest12/,
);
assert.doesNotMatch(workflow, /node-version: '20'/);
assert.match(
  manualDryRun,
  /needs: \[verify, build-and-test, compatibility-node24\]/,
);
assert.match(
  publishNpm,
  /needs: \[verify, build-and-test, compatibility-node24\]/,
);

assert.match(buildAndTest, /node scripts\/release-artifact\.js pack/);
assert.match(buildAndTest, /actions\/upload-artifact@[0-9a-f]{40}/);
assert.match(
  buildAndTest,
  /release-package-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/,
);
assert.equal(
  (
    workflow.match(
      /name: release-package-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/g,
    ) || []
  ).length,
  5,
  'producer and every downstream consumer must use the same run artifact name',
);
assert.match(buildAndTest, /OUTBOX_TGZ:/);
assert.match(buildAndTest, /OUTBOX_TGZ_METADATA:/);
assert.match(compatibilityNode24, /needs: \[verify, build-and-test\]/);
for (const [name, definition] of [
  ['compatibility-node24', compatibilityNode24],
  ['manual-dry-run', manualDryRun],
  ['publish-npm', publishNpm],
]) {
  assert.match(definition, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(definition, /node scripts\/release-artifact\.js verify/);
  assert.match(definition, /OUTBOX_TGZ:/);
  assert.match(definition, /OUTBOX_TGZ_METADATA:/);
  assert.doesNotMatch(
    definition,
    /npm run build|npm run prepublishOnly|npm pack/,
    `${name} must consume the verified tarball without rebuilding it`,
  );
}
assert.match(
  manualDryRun,
  /npm publish "\$OUTBOX_TGZ" --ignore-scripts --access public --dry-run/,
);

assert.match(publishNpm, /if: github\.event_name == 'push'/);
assert.match(publishNpm, /permissions:\n\s+contents: read\n\s+id-token: write/);
assert.doesNotMatch(publishNpm, /contents: write/);
assert.match(publishNpm, /node scripts\/release-artifact\.js registry-check/);
assert.match(
  publishNpm,
  /npm publish "\$OUTBOX_TGZ" --ignore-scripts --provenance --access public/,
);

assert.match(verifyPublished, /needs: \[verify, publish-npm\]/);
assert.match(
  verifyPublished,
  /node scripts\/release-artifact\.js verify-published/,
);
assert.match(
  verifyPublished,
  /npm audit signatures --json --include-attestations/,
);
assert.match(verifyPublished, /node-version: '24\.15\.0'/);
assert.match(verifyPublished, /npm install --global npm@12\.0\.2/);
assert.match(verifyPublished, /permissions:\n\s+contents: read/);
assert.doesNotMatch(
  verifyPublished,
  /id-token: write|contents: write|npm publish/,
);

assert.match(githubRelease, /if: github\.event_name == 'push'/);
assert.match(githubRelease, /needs: \[verify, verify-published\]/);
assert.match(githubRelease, /permissions:\n\s+contents: write/);
assert.doesNotMatch(githubRelease, /id-token: write|npm publish/);

const sampleStatement = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: [
    {
      name: 'pkg:npm/%40nestarc/outbox@0.0.0',
      digest: { sha512: '00' },
    },
  ],
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {},
};
assert.deepEqual(
  decodeStatements({
    verified: [
      {
        name: '@nestarc/outbox',
        version: '0.0.0',
        attestationBundles: [
          {
            predicateType: sampleStatement.predicateType,
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(sampleStatement)).toString(
                  'base64',
                ),
              },
            },
          },
        ],
      },
    ],
  }),
  [sampleStatement],
);

console.log(
  `Release workflow policy passed (${actionReferences.length} immutable action references)`,
);
