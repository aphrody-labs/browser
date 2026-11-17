#!/usr/bin/env bun

/**
 * Postinstall script for agent-browser
 *
 * Finds the native binary from the platform package (an optional dependency),
 * downloading it from the GitHub release only when that package is missing.
 * Then points the package manager's bin entry at the native binary:
 * - Windows: Overwrites npm's .cmd/.ps1 shims
 * - Mac/Linux: Replaces the npm/yarn/bun symlink or the pnpm shim
 *
 * Install scripts are blocked by default in npm 12, pnpm and bun; the launcher
 * (bin/agent-browser.ts) then performs the same linking on its first run.
 */

import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { linkNative, realpathOrSelf } from './link-native.ts';
import { ensureExecutable, findNativeBinary, nativeTarget } from './native.ts';
import { rootDir as projectRoot } from './workspace.ts';

const binDir = join(projectRoot, 'bin');
const host = `${process.platform}-${process.arch}`;

const target = nativeTarget();
// Windows ARM64 falls back to x64 binary (no native ARM64 build available).
// x64 binaries run via Windows' built-in emulation on ARM64.
const binaryName = target?.binaryName ?? `agent-browser-${host}`;
const binaryPath = join(binDir, binaryName);

const { version } = await Bun.file(join(projectRoot, 'package.json')).json();

// GitHub release URL
const GITHUB_REPO = 'vercel-labs/agent-browser';
const DOWNLOAD_URL = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryName}`;

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: HTTP ${response.status}`);
  }
  await Bun.write(dest, response);
}

/** Package manager running this install, from its user agent string, e.g. "pnpm/8.10.0 node/v20.10.0 linux x64". */
function detectManager(): string {
  const ua = Bun.env.npm_config_user_agent || '';
  return ['pnpm', 'yarn', 'bun', 'npm'].find((name) => ua.startsWith(`${name}/`)) || '';
}

/**
 * Write a marker file next to the binary so `agent-browser upgrade` can use the
 * package manager that installed it, without path heuristics or slow subprocess probing.
 */
async function writeInstallMethod(): Promise<void> {
  const method = detectManager();
  if (!method) return;
  try {
    await Bun.write(join(binDir, '.install-method'), method);
  } catch (err) {
    // Non-critical: upgrade falls back to heuristics
    console.log(`⚠ Could not record the install method: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  if (!target) {
    console.log(`No native binary available for ${host}`);
    return;
  }

  let binary = await findNativeBinary(projectRoot, target);

  if (binary) {
    // The package manager may not preserve the execute bit
    try {
      await ensureExecutable(binary);
    } catch {
      // Read-only package store; the launcher retries before running it
    }
    console.log(`✓ Native binary ready: ${dirname(binary) === binDir ? binaryName : target.packageName}`);
  } else {
    // The platform package is missing, e.g. --omit=optional or a lockfile
    // created on another platform. Fall back to the GitHub release asset.
    console.log(`Downloading native binary for ${host}...`);
    if (process.platform === 'win32' && process.arch === 'arm64') {
      console.log(`  Note: Using x64 binary on ARM64 Windows (runs via emulation)`);
    }
    console.log(`URL: ${DOWNLOAD_URL}`);

    try {
      await downloadFile(DOWNLOAD_URL, binaryPath);
      await ensureExecutable(binaryPath);
      console.log(`✓ Downloaded native binary: ${binaryName}`);
      binary = binaryPath;
    } catch (err) {
      console.log(`Could not download native binary: ${(err as Error).message}`);
      console.log('');
      console.log('To build the native binary locally:');
      console.log('  1. Install Rust: https://rustup.rs');
      console.log('  2. Run: bun run build:native');
    }
  }

  await writeInstallMethod();

  // On global installs, point the bin entry at the native binary directly.
  // This avoids the /bin/sh error on Windows and provides zero-overhead execution.
  if (binary) {
    await fixGlobalInstallBin(binary);
  }

  await showInstallReminder();
}

async function findSystemChrome(): Promise<string | null> {
  const candidates: string[] = [];
  switch (process.platform) {
    case 'darwin':
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      );
      break;
    case 'linux': {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
        const found = Bun.which(name);
        if (found) return found;
      }
      return null;
    }
    case 'win32':
      if (Bun.env.LOCALAPPDATA) candidates.push(`${Bun.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`);
      candidates.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      );
      break;
    default:
      return null;
  }
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

async function showInstallReminder(): Promise<void> {
  const systemChrome = await findSystemChrome();
  if (systemChrome) {
    console.log('');
    console.log(`  ✓ System Chrome found: ${systemChrome}`);
    console.log('    agent-browser will use it automatically.');
    console.log('');
    return;
  }

  console.log('');
  console.log('  ⚠ No Chrome installation detected.');
  console.log('  If you plan to use a local browser, run:');
  console.log('');
  console.log('    agent-browser install');
  if (process.platform === 'linux') {
    console.log('');
    console.log('  On Linux, include system dependencies with:');
    console.log('');
    console.log('    agent-browser install --with-deps');
  }
  console.log('');
  console.log('  You can skip this if you use --cdp, --provider, --engine, or --executable-path.');
  console.log('');
}

/** A manager's global bin directory sits at the prefix itself on Windows. */
function prefixToBin(prefix: string): string {
  return process.platform === 'win32' ? prefix : join(prefix, 'bin');
}

/**
 * True when this package is being installed globally. Only npm reports it
 * directly; the others are recognised by the global store their files land in.
 */
async function isGlobalInstall(): Promise<boolean> {
  if (Bun.env.npm_config_global === 'true') return true;
  const root = await realpathOrSelf(projectRoot);
  for (const dir of [Bun.env.PNPM_HOME, Bun.env.BUN_INSTALL_GLOBAL_DIR, Bun.env.YARN_GLOBAL_FOLDER]) {
    if (dir && root.startsWith(await realpathOrSelf(dir))) return true;
  }
  return root.includes(`${sep}global${sep}`);
}

/** Asks the invoking package manager for its global bin directory, or null. */
async function probeGlobalBin(manager: string): Promise<string | null> {
  const probes: Record<string, string[]> = {
    pnpm: ['pnpm', 'bin', '-g'],
    yarn: ['yarn', 'global', 'bin'],
    bun: [process.execPath, 'pm', 'bin', '-g'],
    npm: ['npm', 'prefix', '-g'],
  };
  const [command, ...args] = probes[manager];
  const proc = Bun.spawn([Bun.which(command) ?? command, ...args], {
    cwd: tmpdir(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: 5000,
    windowsHide: true,
  });
  const [out, code] = await Promise.all([Bun.readableStreamToText(proc.stdout), proc.exited]);
  if (code !== 0) return null;
  const line = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line || !isAbsolute(line)) return null;
  return manager === 'npm' ? prefixToBin(line) : line;
}

/**
 * Global bin directories that may hold this package's bin entry: the prefix
 * npm reports, the invoking manager's own answer, and the enclosing
 * node_modules/.bin that Yarn Classic links through before its global link
 * exists. linkNative only rewrites an entry resolving to this package.
 */
async function globalBinCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  const prefix = Bun.env.npm_config_prefix;
  if (prefix) {
    candidates.push(prefixToBin(prefix));
  }

  const manager = detectManager();
  const needsProbe = manager && (await isGlobalInstall()) && !(manager === 'npm' && prefix);
  if (needsProbe) {
    try {
      const bin = await probeGlobalBin(manager);
      if (bin) candidates.push(bin);
    } catch {
      // The manager is not on PATH: the candidates found so far still apply.
      return candidates;
    }
  }

  const parent = join(projectRoot, '..');
  if (basename(parent) === 'node_modules') {
    candidates.push(join(parent, '.bin'));
  }

  return [...new Set(candidates)];
}

/** Points the global bin entry at the native binary, skipping the launcher entirely. */
async function fixGlobalInstallBin(binary: string): Promise<void> {
  const entries = (await globalBinCandidates()).map((dir) => join(dir, 'agent-browser'));

  try {
    if (await linkNative({ packageRoot: projectRoot, binary, target: target!, entries })) {
      console.log('✓ Optimized: bin entry points to native binary (zero overhead)');
    }
  } catch (err) {
    // Permission error or other issue - not critical, the launcher links on first run
    console.log(`⚠ Could not optimize bin entry: ${(err as Error).message}`);
    console.log('  CLI will work via the launcher until its first run links the native binary');
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
}
