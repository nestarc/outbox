const assert = require('node:assert/strict');
const fs = require('node:fs');

const rootPath = require.resolve('@nestarc/outbox');
assert.match(rootPath, /dist[\\/]index\.js$/);
const outbox = require('@nestarc/outbox');
assert.equal(typeof outbox.OutboxModule, 'function');

for (const sqlPath of [
  '@nestarc/outbox/src/sql/create-outbox-table.sql',
  '@nestarc/outbox/src/sql/upgrade-to-current.sql',
]) {
  const resolved = require.resolve(sqlPath);
  assert.match(fs.readFileSync(resolved, 'utf8'), /outbox_events/);
}

assert.throws(
  () => require.resolve('@nestarc/outbox/dist/outbox.poller.js'),
  (error) => error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
);
assert.throws(
  () => require.resolve('@nestarc/outbox/src/sql/upgrade-add-lease.sql'),
  (error) => error && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
);
assert.throws(
  () => require.resolve('pg'),
  (error) => error && error.code === 'MODULE_NOT_FOUND',
);
