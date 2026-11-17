#!/usr/bin/env bun

/**
 * Copies the compiled Rust binary to bin/ with platform-specific naming
 */

import { join } from 'node:path';
import { ensureExecutable } from './native.ts';
import { findCliDir, rootDir, toRelative } from './workspace.ts';

const ext = process.platform === 'win32' ? '.exe' : '';
const cliDir = await findCliDir();
const sourcePath = join(Bun.env.CARGO_TARGET_DIR ?? join(cliDir, 'target'), 'release', `agent-browser${ext}`);
const targetPath = join(rootDir, 'bin', `agent-browser-${process.platform}-${process.arch}${ext}`);

if (!(await Bun.file(sourcePath).exists())) {
  console.error(`Error: Native binary not found at ${sourcePath}`);
  console.error(`Run "cargo build --release --manifest-path ${toRelative(cliDir)}/Cargo.toml" first`);
  process.exit(1);
}

await Bun.write(targetPath, Bun.file(sourcePath));
await ensureExecutable(targetPath);
console.log(`✓ Copied native binary to ${targetPath}`);
