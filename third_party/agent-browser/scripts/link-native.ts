/**
 * Points package-manager bin entries for agent-browser at the native binary,
 * so later invocations skip the launcher entirely.
 *
 * Run by postinstall when install scripts are allowed, and by the launcher on
 * its first invocation when they are not (npm 12, pnpm and bun block
 * dependency install scripts by default). Every step is best effort, and an
 * entry is only rewritten when it provably targets this package's launcher.
 */

// Bun has no API for hard links, symlinks, lstat, realpath, chmod or an atomic rename: the rest of the file I/O is Bun.file/Bun.write.
// eslint-disable-next-line import/no-nodejs-modules
import { chmod, link, lstat, realpath, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { NativeTarget } from './native.ts';

const isWindows = process.platform === 'win32';

// A shim is a few lines; anything larger is a real executable that must not be read as text.
const MAX_SHIM_SIZE = 64 * 1024;

async function readShim(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return file.size > MAX_SHIM_SIZE ? null : await file.text();
}

/**
 * Ensures the binary lives in this package's own bin/ directory and returns
 * that path. Bin entries must target files inside the package that owns them:
 * npm only removes such links on uninstall, and bun refuses to replace a
 * global bin entry that points into another package.
 */
export async function materializeBinary(packageRoot: string, binary: string, target: NativeTarget): Promise<string> {
  const binDir = join(packageRoot, 'bin');
  if (dirname(resolve(binary)) === resolve(binDir)) return binary;

  const destination = join(binDir, target.binaryName);
  const staged = `${destination}.install-${process.pid}`;
  try {
    try {
      await link(binary, staged);
    } catch {
      // Another filesystem or a store that forbids links: copy instead.
      await Bun.write(staged, Bun.file(binary));
    }
    if (!isWindows) await chmod(staged, 0o755);
    await rename(staged, destination);
  } finally {
    await rm(staged, { force: true });
  }
  return destination;
}

/** Writes `content` to `path` atomically, leaving the original intact on failure. */
async function replaceFile(path: string, content: string, mode?: number): Promise<boolean> {
  const staged = `${path}.install-${process.pid}`;
  try {
    await Bun.write(staged, content);
    if (mode !== undefined) await chmod(staged, mode);
    await rename(staged, path);
    return true;
  } catch {
    // Read-only install: the original entry stays and keeps running the launcher.
    await rm(staged, { force: true });
    return false;
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    // A path that does not resolve is not the same file.
    return false;
  }
}

async function isLauncherSymlink(entry: string, launcher: string): Promise<boolean> {
  try {
    return (await lstat(entry)).isSymbolicLink() && (await sameFile(entry, launcher));
  } catch {
    // No such entry.
    return false;
  }
}

// npm, yarn and bun link bin entries as symlinks on macOS and Linux.
async function relinkSymlink(entry: string, binary: string): Promise<boolean> {
  const staged = join(dirname(entry), `.${basename(entry)}-${process.pid}`);
  try {
    await symlink(binary, staged);
    await rename(staged, entry);
    return true;
  } catch {
    // The directory is not writable: the entry keeps running the launcher.
    await rm(staged, { force: true });
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * pnpm writes a shell shim that runs `node <launcher>`, named in a
 * `# cmd-shim-target=` comment. The comment is kept so pnpm still recognizes
 * the shim as its own when it updates or removes the package.
 */
export function pnpmShimPaths(invokedPath: string): string[] {
  const match = invokedPath.match(
    /^(.*)[\\/]global[\\/][^\\/]+[\\/](?:[^\\/]+[\\/])?node_modules[\\/]agent-browser[\\/]bin[\\/]agent-browser\.ts$/
  );
  if (!match) return [];
  return [join(match[1], 'bin', 'agent-browser'), join(match[1], 'agent-browser')];
}

async function relinkPnpmShim(shim: string, launcher: string, binary: string): Promise<boolean> {
  let content: string | null;
  try {
    content = await readShim(shim);
  } catch {
    // Not a pnpm shim location on this install.
    return false;
  }
  if (content === null) return false;
  const declared = content.match(/^# cmd-shim-target=(.+)$/m)?.[1];
  if (!declared || !(await sameFile(declared, launcher))) return false;
  const marker = `# cmd-shim-target=${declared}`;
  return replaceFile(shim, `#!/bin/sh\n${marker}\nexec ${shellQuote(binary)} "$@"\n`, 0o755);
}

/** Returns the launcher path an npm Windows shim runs, or null. */
async function windowsShimTarget(shim: string, shimDir: string): Promise<string | null> {
  let content: string | null;
  try {
    content = await readShim(shim);
  } catch {
    // The package manager wrote no shim of this kind.
    return null;
  }
  if (content === null) return null;
  const patterns = [
    /"%(?:~dp0|dp0%)\\([^"\r\n]+?)"\s+%\*/,
    /"\$basedir[/\\]([^"\r\n]+?)"\s+\$args/,
    /"\$basedir[/\\]([^"\r\n]+?)"\s+"\$@"/,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return resolve(shimDir, match[1].replace(/\\/g, '/'));
  }
  return null;
}

function windowsShimBody(shim: string, rel: string): string {
  const slash = rel.replace(/\\/g, '/');
  const backslash = rel.replace(/\//g, '\\');
  if (shim.endsWith('.cmd')) return `@ECHO off\r\n"%~dp0\\${backslash}" %*\r\n`;
  if (shim.endsWith('.ps1')) {
    return `#!/usr/bin/env pwsh\r\n$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\r\n& "$basedir/${slash}" $args\r\nexit $LASTEXITCODE\r\n`;
  }
  return `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec "$basedir/${slash}" "$@"\n`;
}

/**
 * Rewrites npm's Windows .cmd/.ps1/sh shims in the global prefix so they run
 * the native binary. Only a shim that resolves to this package's launcher is
 * touched, and each is replaced atomically.
 */
async function relinkWindowsShims(packageRoot: string, linked: () => Promise<string>): Promise<boolean> {
  const nodeModules = dirname(packageRoot);
  if (basename(packageRoot) !== 'agent-browser' || basename(nodeModules) !== 'node_modules') return false;
  const prefix = dirname(nodeModules);
  const launcher = join(packageRoot, 'bin', 'agent-browser.ts');

  let binary: string | undefined;
  let changed = false;
  for (const name of ['agent-browser.cmd', 'agent-browser.ps1', 'agent-browser']) {
    const shim = join(prefix, name);
    const target = await windowsShimTarget(shim, prefix);
    if (!target || !(await sameFile(target, launcher))) continue;
    binary ??= await linked();
    changed = (await replaceFile(shim, windowsShimBody(shim, relative(prefix, binary)))) || changed;
  }
  return changed;
}

export async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // The path does not exist yet: it stands for itself.
    return path;
  }
}

export interface LinkNativeOptions {
  packageRoot: string;
  binary: string;
  target: NativeTarget;
  entries?: string[];
}

/**
 * Rewrites every bin entry that runs the launcher so it runs the native
 * binary from this package's own bin/, which keeps skills/, skill-data/ and
 * .install-method reachable from the executable.
 *
 * - packageRoot: this package's directory (real path)
 * - binary: the native binary found by findNativeBinary
 * - target: the nativeTarget for this host
 * - entries: paths that may be symlinks to the launcher, pnpm shims, or the
 *   launcher .ts a pnpm shim runs (e.g. Bun.argv[1])
 *
 * Returns true when at least one entry now runs the native binary.
 */
export async function linkNative({ packageRoot, binary, target, entries = [] }: LinkNativeOptions): Promise<boolean> {
  const launcher = join(packageRoot, 'bin', 'agent-browser.ts');
  const linked = () => materializeBinary(packageRoot, binary, target);

  if (isWindows) {
    return relinkWindowsShims(packageRoot, linked);
  }

  let changed = false;
  for (const entry of entries) {
    if (await isLauncherSymlink(entry, launcher)) {
      try {
        changed = (await relinkSymlink(entry, await linked())) || changed;
      } catch {
        // Read-only or root-owned install: keep using the launcher.
      }
    }
    for (const shim of [entry, ...pnpmShimPaths(entry)]) {
      try {
        changed = (await relinkPnpmShim(shim, launcher, await realpathOrSelf(await linked()))) || changed;
      } catch {
        // Read-only or root-owned install: keep using the launcher.
      }
    }
  }
  return changed;
}
