#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseExpected(argument) {
  const separator = argument.lastIndexOf('@');
  if (separator <= 0 || separator === argument.length - 1) {
    throw new Error(`Expected <package>@<exact-version>, received "${argument}"`);
  }
  return {
    packageName: argument.slice(0, separator),
    expectedVersion: argument.slice(separator + 1),
  };
}

function installedVersion(workspaceDirectory, packageName) {
  const manifestPath = path.join(
    workspaceDirectory,
    'node_modules',
    ...packageName.split('/'),
    'package.json',
  );
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version;
}

function main(args = process.argv.slice(2)) {
  if (args.length === 0) {
    throw new Error('Provide at least one <package>@<exact-version> assertion');
  }

  const workspaceDirectory = path.resolve(__dirname, '..');
  for (const argument of args) {
    const { packageName, expectedVersion } = parseExpected(argument);
    const actualVersion = installedVersion(workspaceDirectory, packageName);
    if (actualVersion !== expectedVersion) {
      throw new Error(
        `Installed ${packageName}@${actualVersion}; expected ${expectedVersion}`,
      );
    }
    console.log(`${packageName}@${actualVersion}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = { installedVersion, parseExpected };
