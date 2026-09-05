#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const lock = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
);
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const release = fs.readFileSync(
  path.join(root, '.github/workflows/release.yml'),
  'utf8',
);

const expected = {
  node: '>=22.0.0',
  common: '^10.0.0 || ^11.0.0 || ^12.0.0',
  core: '^10.0.0 || ^11.0.0 || ^12.0.0',
  schedule: '^4.0.0 || ^5.0.0 || ^12.0.0',
};

assert.equal(manifest.engines.node, expected.node);
assert.equal(manifest.peerDependencies['@nestjs/common'], expected.common);
assert.equal(manifest.peerDependencies['@nestjs/core'], expected.core);
assert.equal(manifest.peerDependencies['@nestjs/schedule'], expected.schedule);

const lockedRoot = lock.packages[''];
assert.equal(lockedRoot.engines.node, expected.node);
assert.equal(lockedRoot.peerDependencies['@nestjs/common'], expected.common);
assert.equal(lockedRoot.peerDependencies['@nestjs/core'], expected.core);
assert.equal(
  lockedRoot.peerDependencies['@nestjs/schedule'],
  expected.schedule,
);

assert.match(readme, /Node 22 is the minimum supported runtime/);
assert.match(readme, /\| 22\/24 \| 12\.0\.1\s+\| 12\.0\.1\s+\| 7\.10\.0/);
assert.match(readme, /Node 26 is pre-LTS.*allowed-failure canary/s);

for (const [name, workflow] of [
  ['CI', ci],
  ['release', release],
]) {
  assert.doesNotMatch(
    workflow,
    /node-version: '20'/,
    `${name} retains Node 20`,
  );
  assert.match(workflow, /node-version: '22'/, `${name} lacks Node 22`);
  assert.match(workflow, /node-version: '24'/, `${name} lacks Node 24`);
  assert.match(
    workflow,
    /npm run test:nest12-consumer/,
    `${name} lacks the NestJS 12 packed consumer`,
  );
}

assert.match(ci, /nestjs: '12\.0\.1'[\s\S]*schedule: '12\.0\.1'/);
assert.match(ci, /node26-canary:[\s\S]*continue-on-error: true/);
assert.match(ci, /node-version: '26'/);
assert.doesNotMatch(release, /node-version: '26'/);

console.log(
  'Compatibility policy passed (Node 22/24 required, NestJS 12 controlled, Node 26 canary only)',
);
