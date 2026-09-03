#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
const manualDryRun = job('manual-dry-run');
const publishNpm = job('publish-npm');
const githubRelease = job('github-release');

for (const [name, definition] of [
  ['verify', verify],
  ['build-and-test', buildAndTest],
  ['manual-dry-run', manualDryRun],
]) {
  assert.match(definition, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(definition, /id-token: write|contents: write/);
  if (name === 'manual-dry-run') {
    assert.match(definition, /if: github\.event_name == 'workflow_dispatch'/);
    assert.match(definition, /npm publish --access public --dry-run/);
  }
}

assert.match(publishNpm, /if: github\.event_name == 'push'/);
assert.match(publishNpm, /permissions:\n\s+contents: read\n\s+id-token: write/);
assert.doesNotMatch(publishNpm, /contents: write/);
assert.match(publishNpm, /npm publish --provenance --access public/);

assert.match(githubRelease, /if: github\.event_name == 'push'/);
assert.match(githubRelease, /permissions:\n\s+contents: write/);
assert.doesNotMatch(githubRelease, /id-token: write|npm publish/);

console.log(
  `Release workflow policy passed (${actionReferences.length} immutable action references)`,
);
