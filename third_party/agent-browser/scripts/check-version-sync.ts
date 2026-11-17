#!/usr/bin/env bun

/**
 * Verifies that package.json and the Cargo.toml of the crate have the same version.
 * Used in CI to catch version drift.
 */

import { join } from 'node:path';
import { findCliDir, rootDir, toRelative } from './workspace.ts';

const readJson = (...parts: string[]) => Bun.file(join(rootDir, ...parts)).json();

const packageJson = await readJson('package.json');
const packageVersion: string = packageJson.version;

const cargoManifest = `${toRelative(await findCliDir())}/Cargo.toml`;
const cargoToml = await Bun.file(join(rootDir, cargoManifest)).text();
const cargoVersionMatch = cargoToml.match(/^version\s*=\s*"([^"]*)"/m);

if (!cargoVersionMatch) {
  console.error(`Could not find version in ${cargoManifest}`);
  process.exit(1);
}

const cargoVersion = cargoVersionMatch[1];

const dashboardVersion: string = (await readJson('packages', 'dashboard', 'package.json')).version;

const sandboxVersionFile = 'packages/@agent-browser/sandbox/src/version.ts';
const sandboxVersion: string = (await readJson('packages', '@agent-browser', 'sandbox', 'package.json')).version;
const sandboxVersionSource = await Bun.file(join(rootDir, sandboxVersionFile)).text();
const sandboxVersionMatch = sandboxVersionSource.match(/AGENT_BROWSER_SANDBOX_VERSION\s*=\s*"([^"]*)"/);

if (!sandboxVersionMatch) {
  console.error(`Could not find AGENT_BROWSER_SANDBOX_VERSION in ${sandboxVersionFile}`);
  process.exit(1);
}

const sandboxRuntimeVersion = sandboxVersionMatch[1];

const evePkg = await readJson('packages', '@agent-browser', 'eve', 'package.json');
const eveVersion: string = evePkg.version;
const eveSandboxDependency: string | undefined = evePkg.dependencies?.['@agent-browser/sandbox'];

// Native binary package versions
const scopeDir = join(rootDir, 'packages', '@agent-browser');
const nativePackages: { name: string; version: string }[] = [];
for await (const manifest of new Bun.Glob('cli-*/package.json').scan({ cwd: scopeDir })) {
  nativePackages.push({
    name: manifest.split(/[\\/]/)[0],
    version: (await Bun.file(join(scopeDir, manifest)).json()).version,
  });
}
nativePackages.sort((a, b) => a.name.localeCompare(b.name));
const rootOptionalDependencies: Record<string, string> = packageJson.optionalDependencies ?? {};

const mismatches: string[] = [];
if (packageVersion !== cargoVersion) {
  mismatches.push(`  ${cargoManifest}: ${cargoVersion}`);
}
if (packageVersion !== dashboardVersion) {
  mismatches.push(`  packages/dashboard:          ${dashboardVersion}`);
}
if (packageVersion !== sandboxVersion) {
  mismatches.push(`  packages/@agent-browser/sandbox/package.json: ${sandboxVersion}`);
}
if (packageVersion !== sandboxRuntimeVersion) {
  mismatches.push(`  ${sandboxVersionFile}: ${sandboxRuntimeVersion}`);
}
if (packageVersion !== eveVersion) {
  mismatches.push(`  packages/@agent-browser/eve/package.json: ${eveVersion}`);
}
if (eveSandboxDependency !== 'workspace:^') {
  mismatches.push(`  packages/@agent-browser/eve dependency @agent-browser/sandbox: ${eveSandboxDependency}`);
}

for (const { name, version } of nativePackages) {
  if (packageVersion !== version) {
    mismatches.push(`  packages/@agent-browser/${name}/package.json: ${version}`);
  }
  if (rootOptionalDependencies[`@agent-browser/${name}`] !== 'workspace:*') {
    mismatches.push(
      `  package.json optionalDependencies @agent-browser/${name}: ${rootOptionalDependencies[`@agent-browser/${name}`]}`
    );
  }
}

if (mismatches.length > 0) {
  console.error('Version mismatch detected!');
  console.error(`  package.json:                ${packageVersion}`);
  for (const m of mismatches) console.error(m);
  console.error('');
  console.error("Run 'bun run version:sync' to fix this.");
  process.exit(1);
}

console.log(`Versions are in sync: ${packageVersion}`);
