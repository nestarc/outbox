#!/usr/bin/env node
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_PACKED_BYTES = 512 * 1024;
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024;
const REQUIRED_ROOT_FILES = ['LICENSE', 'README.md', 'package.json'];
const REQUIRED_SQL_FILES = [
  'src/sql/create-outbox-table.sql',
  'src/sql/upgrade-0.1-to-0.2.sql',
  'src/sql/upgrade-to-current.sql',
];

function sha512(buffer) {
  return `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function walkFiles(directory, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
    else
      throw new Error(
        `release tarball contains unsupported entry: ${relative}`,
      );
  }
  return files.sort();
}

function assertAllowlisted(files) {
  for (const file of files) {
    const allowed =
      REQUIRED_ROOT_FILES.includes(file) ||
      file.startsWith('dist/') ||
      file.startsWith('src/sql/');
    assert.ok(
      allowed,
      `release tarball contains non-allowlisted file: ${file}`,
    );
  }
  for (const required of [...REQUIRED_ROOT_FILES, ...REQUIRED_SQL_FILES]) {
    assert.ok(
      files.includes(required),
      `release tarball is missing ${required}`,
    );
  }
}

function inspectArchive(tarballPath) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nestarc-outbox-release-artifact-'),
  );
  try {
    const entries = execFileSync('tar', ['-tzf', tarballPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean);
    for (const entry of entries) {
      assert.ok(
        entry === 'package' || entry.startsWith('package/'),
        `release tarball entry escapes package root: ${entry}`,
      );
      assert.ok(
        !entry.split('/').includes('..'),
        `release tarball entry contains parent traversal: ${entry}`,
      );
    }
    execFileSync('tar', ['-xzf', tarballPath, '-C', temporaryDirectory], {
      stdio: 'pipe',
    });
    const packageDirectory = path.join(temporaryDirectory, 'package');
    assert.ok(
      fs.statSync(packageDirectory).isDirectory(),
      'missing package root',
    );
    const files = walkFiles(packageDirectory);
    const unpackedSize = files.reduce(
      (total, file) =>
        total + fs.statSync(path.join(packageDirectory, file)).size,
      0,
    );
    assertAllowlisted(files);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
    );
    const readme = fs.readFileSync(
      path.join(packageDirectory, 'README.md'),
      'utf8',
    );
    for (const sqlFile of [
      'src/sql/create-outbox-table.sql',
      'src/sql/upgrade-to-current.sql',
    ]) {
      assert.ok(
        readme.includes(`@nestarc/outbox/${sqlFile}`),
        `packed README is missing the runnable command for ${sqlFile}`,
      );
    }
    assert.equal(manifest.name, '@nestarc/outbox');
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.deepEqual(manifest.exports, {
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.js',
        default: './dist/index.js',
      },
      './src/sql/create-outbox-table.sql': './src/sql/create-outbox-table.sql',
      './src/sql/upgrade-to-current.sql': './src/sql/upgrade-to-current.sql',
    });
    for (const field of ['main', 'types']) {
      assert.equal(
        typeof manifest[field],
        'string',
        `package ${field} is missing`,
      );
      assert.ok(
        files.includes(manifest[field]),
        `package ${field} target is missing: ${manifest[field]}`,
      );
    }
    return { files, manifest, unpackedSize };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function sourceMetadata(workspaceDirectory) {
  const commit =
    process.env.GITHUB_SHA ||
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceDirectory,
      encoding: 'utf8',
    }).trim();
  const ref =
    process.env.GITHUB_REF ||
    execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], {
      cwd: workspaceDirectory,
      encoding: 'utf8',
    }).trim();
  return {
    repository: 'https://github.com/nestarc/outbox',
    commit,
    ref,
    workflow: '.github/workflows/release.yml',
  };
}

function appendFile(name, lines) {
  const target = process.env[name];
  if (target) fs.appendFileSync(target, `${lines.join('\n')}\n`);
}

function packArtifact(outputDirectory) {
  const workspaceDirectory = path.resolve(__dirname, '..');
  const absoluteOutput = path.resolve(outputDirectory);
  fs.mkdirSync(absoluteOutput, { recursive: true });
  const npmCache = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nestarc-outbox-release-npm-cache-'),
  );
  let output;
  try {
    output = execFileSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        absoluteOutput,
      ],
      {
        cwd: workspaceDirectory,
        encoding: 'utf8',
        env: { ...process.env, npm_config_cache: npmCache },
      },
    );
  } finally {
    fs.rmSync(npmCache, { recursive: true, force: true });
  }
  const packed = JSON.parse(output)[0];
  assert.ok(packed?.filename, 'npm pack did not return a filename');
  assert.ok(packed?.integrity, 'npm pack did not return integrity');

  const originalPath = path.join(absoluteOutput, packed.filename);
  const tarballPath = path.join(absoluteOutput, 'package.tgz');
  fs.renameSync(originalPath, tarballPath);
  const bytes = fs.readFileSync(tarballPath);
  const inspected = inspectArchive(tarballPath);
  assert.equal(inspected.manifest.name, packed.name);
  assert.equal(inspected.manifest.version, packed.version);
  assert.equal(sha512(bytes), packed.integrity);
  assert.ok(bytes.length > 0 && bytes.length <= MAX_PACKED_BYTES);
  assert.equal(inspected.unpackedSize, packed.unpackedSize);
  assert.ok(
    packed.unpackedSize > 0 && packed.unpackedSize <= MAX_UNPACKED_BYTES,
    `unpacked size ${packed.unpackedSize} exceeds ${MAX_UNPACKED_BYTES}`,
  );
  assert.deepEqual(
    inspected.files,
    packed.files.map((entry) => entry.path).sort(),
    'npm metadata file list differs from tarball contents',
  );

  const metadata = {
    schemaVersion: 1,
    name: packed.name,
    version: packed.version,
    filename: 'package.tgz',
    size: bytes.length,
    unpackedSize: packed.unpackedSize,
    integrity: packed.integrity,
    sha256: sha256(bytes),
    files: inspected.files,
    source: sourceMetadata(workspaceDirectory),
  };
  const metadataPath = path.join(absoluteOutput, 'metadata.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(
    `Packed ${metadata.name}@${metadata.version}: ${metadata.integrity} (${metadata.size} bytes, ${metadata.files.length} files)`,
  );
  return metadata;
}

function verifyArtifact(tarballPath, metadataPath) {
  const absoluteTarball = path.resolve(tarballPath);
  const absoluteMetadata = path.resolve(metadataPath);
  const metadata = JSON.parse(fs.readFileSync(absoluteMetadata, 'utf8'));
  const bytes = fs.readFileSync(absoluteTarball);

  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.filename, 'package.tgz');
  assert.equal(metadata.size, bytes.length);
  assert.equal(metadata.integrity, sha512(bytes));
  assert.equal(metadata.sha256, sha256(bytes));
  assert.ok(bytes.length > 0 && bytes.length <= MAX_PACKED_BYTES);
  const inspected = inspectArchive(absoluteTarball);
  assert.equal(metadata.name, inspected.manifest.name);
  assert.equal(metadata.version, inspected.manifest.version);
  assert.deepEqual(metadata.files, inspected.files);
  assert.equal(metadata.unpackedSize, inspected.unpackedSize);
  assert.ok(
    metadata.unpackedSize > 0 && metadata.unpackedSize <= MAX_UNPACKED_BYTES,
  );
  assert.equal(metadata.source.repository, 'https://github.com/nestarc/outbox');
  assert.equal(metadata.source.workflow, '.github/workflows/release.yml');
  assert.match(metadata.source.commit, /^[0-9a-f]{40}$/);
  assert.match(metadata.source.ref, /^refs\//);
  if (process.env.GITHUB_SHA) {
    assert.equal(metadata.source.commit, process.env.GITHUB_SHA);
  }
  if (process.env.GITHUB_REF) {
    assert.equal(metadata.source.ref, process.env.GITHUB_REF);
  }
  console.log(
    `Verified ${metadata.name}@${metadata.version}: ${metadata.integrity} (${metadata.sha256})`,
  );
  return metadata;
}

function parseNpmView(raw) {
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) return value;
  assert.equal(
    value.length,
    1,
    'exact npm version must return exactly one result',
  );
  return value[0];
}

function npmView(spec, field) {
  try {
    return parseNpmView(
      execFileSync('npm', ['view', spec, field, '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    );
  } catch (error) {
    const detail = `${error.stdout || ''}\n${error.stderr || ''}`;
    if (/E404|404 Not Found/.test(detail)) return null;
    throw new Error(`npm view failed: ${detail.trim()}`);
  }
}

function registryCheck(tarballPath, metadataPath) {
  const metadata = verifyArtifact(tarballPath, metadataPath);
  const raw = npmView(`${metadata.name}@${metadata.version}`, 'dist.integrity');
  if (raw === null) {
    appendFile('GITHUB_OUTPUT', ['action=publish']);
    console.log(`${metadata.name}@${metadata.version} is not published`);
    return 'publish';
  }
  const registryIntegrity = raw;
  assert.equal(
    registryIntegrity,
    metadata.integrity,
    `${metadata.name}@${metadata.version} already exists with different bytes`,
  );
  appendFile('GITHUB_OUTPUT', ['action=skip']);
  console.log(
    `${metadata.name}@${metadata.version} already has identical bytes; publish is idempotently skipped`,
  );
  return 'skip';
}

function allStrings(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) {
    for (const entry of value) allStrings(entry, result);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) allStrings(entry, result);
  }
  return result;
}

function decodeStatements(audit) {
  const statements = [];
  for (const verified of audit.verified || []) {
    const bundles =
      verified.attestationBundles || verified.attestations?.bundles || [];
    for (const entry of bundles) {
      const envelope = entry.bundle?.dsseEnvelope || entry.dsseEnvelope;
      if (!envelope?.payload) continue;
      statements.push(
        JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')),
      );
    }
  }
  return statements;
}

function verifyPublished(tarballPath, metadataPath, auditPath) {
  const metadata = verifyArtifact(tarballPath, metadataPath);
  const spec = `${metadata.name}@${metadata.version}`;
  const rawDist = npmView(spec, 'dist');
  assert.notEqual(rawDist, null, `${spec} is not published`);
  const dist = rawDist;
  assert.equal(dist.integrity, metadata.integrity);
  assert.match(
    dist.attestations?.provenance?.predicateType || '',
    /slsa\.dev\/provenance/,
  );

  const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  assert.deepEqual(audit.invalid || [], [], 'npm found invalid signatures');
  const verified = (audit.verified || []).find(
    (entry) =>
      entry.name === metadata.name && entry.version === metadata.version,
  );
  assert.ok(verified, `npm did not verify ${spec}`);
  const statements = decodeStatements({ verified: [verified] });
  const publishStatement = statements.find((statement) =>
    /npm\/attestation\/.+\/publish\//.test(statement.predicateType || ''),
  );
  const provenance = statements.find((statement) =>
    /slsa\.dev\/provenance/.test(statement.predicateType || ''),
  );
  assert.ok(publishStatement, `${spec} has no verified publish statement`);
  assert.ok(provenance, `${spec} has no verified provenance statement`);

  const expectedBase64 = metadata.integrity.slice('sha512-'.length);
  const expectedHex = Buffer.from(expectedBase64, 'base64').toString('hex');
  for (const [kind, statement] of [
    ['publish', publishStatement],
    ['provenance', provenance],
  ]) {
    const subject = (statement.subject || []).find((entry) => {
      const digest = entry.digest?.sha512;
      return digest === expectedBase64 || digest === expectedHex;
    });
    assert.ok(subject, `${kind} subject does not match the tarball sha512`);
    assert.match(subject.name || '', /(?:%40|@)nestarc\/outbox@/);
  }

  const strings = allStrings(provenance);
  for (const expected of [
    metadata.source.repository,
    metadata.source.commit,
    metadata.source.ref,
    metadata.source.workflow,
  ]) {
    assert.ok(
      strings.some((value) => value.includes(expected)),
      `verified provenance is missing ${expected}`,
    );
  }
  console.log(
    `Verified registry integrity and provenance subject/ref/digest for ${spec}`,
  );
}

function usage() {
  console.error(
    'usage: release-artifact.js <pack DIR | verify TGZ META | registry-check TGZ META | verify-published TGZ META AUDIT_JSON>',
  );
  process.exitCode = 2;
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'pack' && args.length === 1) {
    packArtifact(args[0]);
    // Only the workflow-owned CLI artifact survives for later Actions steps.
    // Library callers delete their temporary artifacts after consumer tests.
    const outputDirectory = path.resolve(args[0]);
    appendFile('GITHUB_ENV', [
      `OUTBOX_TGZ=${path.join(outputDirectory, 'package.tgz')}`,
      `OUTBOX_TGZ_METADATA=${path.join(outputDirectory, 'metadata.json')}`,
    ]);
  } else if (command === 'verify' && args.length === 2) {
    verifyArtifact(args[0], args[1]);
  } else if (command === 'registry-check' && args.length === 2) {
    registryCheck(args[0], args[1]);
  } else if (command === 'verify-published' && args.length === 3) {
    verifyPublished(args[0], args[1], args[2]);
  } else usage();
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = {
  decodeStatements,
  inspectArchive,
  packArtifact,
  parseNpmView,
  registryCheck,
  verifyArtifact,
  verifyPublished,
};
