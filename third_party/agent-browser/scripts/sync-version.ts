#!/usr/bin/env bun

/**
 * Syncs the version from package.json to all other config files.
 * Run this script before building or releasing.
 */

import { join } from 'node:path';
import { findCliDir, rootDir, toRelative } from './workspace.ts';

const cliDir = await findCliDir();
const cliName = toRelative(cliDir);

async function nativePackageManifests(): Promise<string[]> {
  const scopeDir = join(rootDir, 'packages', '@agent-browser');
  const manifests: string[] = [];
  for await (const manifest of new Bun.Glob('cli-*/package.json').scan({ cwd: scopeDir, absolute: true })) {
    manifests.push(manifest);
  }
  return manifests.sort();
}

// package.json is the single source of truth
const packageJson = await Bun.file(join(rootDir, 'package.json')).json();
const version: string = packageJson.version;

console.log(`Syncing version ${version} to all config files...`);

// Update Cargo.toml
const cargoTomlPath = join(cliDir, 'Cargo.toml');
let cargoToml = await Bun.file(cargoTomlPath).text();
const cargoVersionRegex = /^version\s*=\s*"[^"]*"/m;
const newCargoVersion = `version = "${version}"`;

let cargoTomlUpdated = false;
if (cargoVersionRegex.test(cargoToml)) {
  const oldMatch = cargoToml.match(cargoVersionRegex)?.[0];
  if (oldMatch !== newCargoVersion) {
    cargoToml = cargoToml.replace(cargoVersionRegex, newCargoVersion);
    await Bun.write(cargoTomlPath, cargoToml);
    console.log(`  Updated ${cliName}/Cargo.toml: ${oldMatch} -> ${newCargoVersion}`);
    cargoTomlUpdated = true;
  } else {
    console.log(`  ${cliName}/Cargo.toml already up to date`);
  }
} else {
  console.error(`  Could not find version field in ${cliName}/Cargo.toml`);
  process.exit(1);
}

/** Sets `version` in a package.json; `edit` fixes further fields and reports whether it changed any. */
interface Manifest {
  version: string;
  dependencies: Record<string, string>;
}

async function syncPackage(path: string, edit?: (pkg: Manifest) => boolean): Promise<void> {
  const name = toRelative(path);
  const pkg: Manifest = await Bun.file(path).json();
  const oldVersion = pkg.version;
  const extraChanged = edit?.(pkg) ?? false;
  if (oldVersion === version && !extraChanged) {
    console.log(`  ${name} already up to date`);
    return;
  }
  pkg.version = version;
  await Bun.write(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  Updated ${name}: ${oldVersion} -> ${version}`);
}

await syncPackage(join(rootDir, 'packages', 'dashboard', 'package.json'));
await syncPackage(join(rootDir, 'packages', '@agent-browser', 'sandbox', 'package.json'));

// Eve: version + workspace sandbox dependency
const eveSandboxDependency = 'workspace:^';
await syncPackage(join(rootDir, 'packages', '@agent-browser', 'eve', 'package.json'), (pkg) => {
  if (pkg.dependencies['@agent-browser/sandbox'] === eveSandboxDependency) return false;
  pkg.dependencies['@agent-browser/sandbox'] = eveSandboxDependency;
  return true;
});

// Native binary packages
for (const manifest of await nativePackageManifests()) {
  await syncPackage(manifest);
}

// Package runtime version constant
const sandboxVersionPath = join(rootDir, 'packages', '@agent-browser', 'sandbox', 'src', 'version.ts');
const sandboxVersionSource = `export const AGENT_BROWSER_SANDBOX_VERSION = "${version}";\n`;
if ((await Bun.file(sandboxVersionPath).text()) !== sandboxVersionSource) {
  await Bun.write(sandboxVersionPath, sandboxVersionSource);
  console.log(`  Updated ${toRelative(sandboxVersionPath)} -> ${version}`);
} else {
  console.log(`  ${toRelative(sandboxVersionPath)} already up to date`);
}

// Update Cargo.lock to match Cargo.toml
if (cargoTomlUpdated) {
  const cargoUpdate = async (...flags: string[]) => {
    const proc = Bun.spawn(['cargo', 'update', '-p', 'agent-browser', ...flags], {
      cwd: cliDir,
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
    });
    const [stderr, code] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited]);
    return { ok: code === 0, stderr };
  };
  // --offline fails when the package is not in the cache, so retry online
  const result = (await cargoUpdate('--offline')).ok ? { ok: true, stderr: '' } : await cargoUpdate();
  if (result.ok) console.log(`  Updated ${cliName}/Cargo.lock`);
  else console.error(`  Warning: Could not update Cargo.lock: ${result.stderr.trim()}`);
}

console.log('Version sync complete.');
