#!/usr/bin/env bun

/**
 * Copies release binaries into the per-platform npm packages.
 *
 * Usage: bun scripts/stage-native-packages.ts <artifacts-dir>
 *
 * The artifacts directory holds the files built by the release workflow
 * (agent-browser-linux-x64, agent-browser-win32-x64.exe, ...), in any layout.
 * Each one is copied to packages/@agent-browser/cli-<key>/bin/. Exits non-zero
 * if any binary is missing or implausibly small.
 */

import { basename, join } from 'node:path';
import { ensureExecutable } from './native.ts';
import { rootDir } from './workspace.ts';

const MIN_SIZE = 100000;

// Release artifact name -> platform package directory and executable name
const NATIVE_PACKAGES = [
  ['agent-browser-darwin-arm64', 'cli-darwin-arm64', 'agent-browser'],
  ['agent-browser-darwin-x64', 'cli-darwin-x64', 'agent-browser'],
  ['agent-browser-linux-x64', 'cli-linux-x64-gnu', 'agent-browser'],
  ['agent-browser-linux-arm64', 'cli-linux-arm64-gnu', 'agent-browser'],
  ['agent-browser-linux-musl-x64', 'cli-linux-x64-musl', 'agent-browser'],
  ['agent-browser-linux-musl-arm64', 'cli-linux-arm64-musl', 'agent-browser'],
  ['agent-browser-win32-x64.exe', 'cli-win32-x64-msvc', 'agent-browser.exe'],
] as const;

async function findFiles(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const path of new Bun.Glob('**/*').scan({ cwd: directory, absolute: true })) {
    files.set(basename(path), path);
  }
  return files;
}

const artifactsDir = Bun.argv[2];
if (!artifactsDir) {
  console.error('Usage: bun scripts/stage-native-packages.ts <artifacts-dir>');
  process.exit(1);
}

const artifacts = await findFiles(artifactsDir);
let errors = 0;
for (const [artifact, packageDir, file] of NATIVE_PACKAGES) {
  const source = artifacts.get(artifact);
  if (!source) {
    console.error(`ERROR: Missing ${artifact}`);
    errors++;
    continue;
  }
  const size = Bun.file(source).size;
  if (size < MIN_SIZE) {
    console.error(`ERROR: ${artifact} is too small (${size} bytes, expected >= ${MIN_SIZE})`);
    errors++;
    continue;
  }
  const destination = join(rootDir, 'packages', '@agent-browser', packageDir, 'bin', file);
  await Bun.write(destination, Bun.file(source));
  await ensureExecutable(destination);
  console.log(`OK: ${artifact} -> packages/@agent-browser/${packageDir}/bin/${file} (${size} bytes)`);
}

if (errors > 0) {
  console.error(`Error: ${errors} binary issues found`);
  process.exit(1);
}
console.log(`All ${NATIVE_PACKAGES.length} platform packages staged`);
