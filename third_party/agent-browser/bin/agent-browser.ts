#!/usr/bin/env bun

/**
 * Cross-platform CLI launcher for agent-browser
 *
 * Runs the native binary from the platform package (an optional dependency
 * such as @agent-browser/cli-linux-x64-gnu) or from this package's bin/.
 * On first use it also points the package manager's bin entry at the native
 * binary, so later invocations skip the launcher entirely, even when install
 * scripts were blocked.
 */

import { dirname, resolve } from 'node:path';
import { ensureExecutable, findNativeBinary, nativeTarget } from '../scripts/native.ts';

const packageRoot = dirname(import.meta.dir);
const host = `${process.platform}-${process.arch}`;

const target = nativeTarget();

if (!target) {
  console.error(`Error: Unsupported platform: ${host}`);
  process.exit(1);
}

const binaryPath = await findNativeBinary(packageRoot, target);

if (!binaryPath) {
  console.error(`Error: No binary found for ${host}`);
  console.error(`Expected the ${target.packageName} package to be installed.`);
  console.error('');
  console.error('Reinstall agent-browser with optional dependencies enabled,');
  console.error('or run "bun run build:native" to build for your platform.');
  process.exit(1);
}

try {
  await ensureExecutable(binaryPath);
} catch (err) {
  console.error(`Error: Cannot make binary executable: ${(err as Error).message}`);
  console.error(`Try running: chmod +x ${binaryPath}`);
  process.exit(1);
}

let runPath = binaryPath;
try {
  const { linkNative, materializeBinary } = await import('../scripts/link-native.ts');
  try {
    runPath = await materializeBinary(packageRoot, binaryPath, target);
  } catch {
    // The package directory is read-only: run the binary where it is.
    runPath = binaryPath;
  }
  // Bun reports the resolved script path as argv[1], so a symlinked bin entry is recovered from PATH and from the
  // shell's `_` variable. linkNative only rewrites an entry that provably runs this launcher.
  const invoked = [Bun.which('agent-browser'), Bun.env._ ? resolve(Bun.env._) : null];
  const entries = [Bun.argv[1], ...invoked.filter((entry): entry is string => entry !== null)];
  await linkNative({ packageRoot, binary: runPath, target, entries });
} catch {
  // Linking is an optimization; this launcher keeps working without it.
}

try {
  const child = Bun.spawn([runPath, ...Bun.argv.slice(2)], {
    stdio: ['inherit', 'inherit', 'inherit'],
    windowsHide: true,
  });
  await child.exited;
  process.exit(child.exitCode ?? 0);
} catch (err) {
  console.error(`Error executing binary: ${(err as Error).message}`);
  process.exit(1);
}
