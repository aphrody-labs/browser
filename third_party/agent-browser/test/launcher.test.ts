// Bun has no API for chmod, symlinks, realpath or temporary directories.
/* eslint-disable import/no-nodejs-modules */
import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, readlink, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { NativeTarget } from '../scripts/native.ts';

const repositoryRoot = dirname(import.meta.dir);
const launcherPath = join(repositoryRoot, 'bin', 'agent-browser.ts');
const sharedModules = ['native.ts', 'link-native.ts'];

// The fake binaries are shell scripts, which Windows cannot execute.
const posix = process.platform !== 'win32';
const runsBinaries = test.skipIf(!posix);

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await Bun.$`rm -rf ${path}`.quiet();
});

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(path);
  return path;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function writeExecutable(path: string, content: string, mode = 0o755): Promise<void> {
  await Bun.write(path, content);
  await chmod(path, mode);
}

// Creates a package directory holding the launcher and the modules it imports.
async function createPackage(packageRoot?: string): Promise<string> {
  packageRoot ??= await tempDir('agent-browser-launcher-');
  await Bun.write(join(packageRoot, 'package.json'), '{"type":"module"}\n');
  await writeExecutable(join(packageRoot, 'bin', 'agent-browser.ts'), await Bun.file(launcherPath).text());
  for (const name of sharedModules) {
    await Bun.write(join(packageRoot, 'scripts', name), Bun.file(join(repositoryRoot, 'scripts', name)));
  }
  return packageRoot;
}

async function writeFakeBinary(path: string, marker: string): Promise<void> {
  await writeExecutable(path, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(marker)} "$@"\n`);
}

// Installs a fake platform package, as npm does for optionalDependencies.
async function writePlatformPackage(
  packageRoot: string,
  packageName: string,
  file: string,
  marker: string
): Promise<string> {
  const directory = join(packageRoot, 'node_modules', ...packageName.split('/'));
  await Bun.write(join(directory, 'package.json'), JSON.stringify({ name: packageName }));
  await writeFakeBinary(join(directory, 'bin', file), marker);
  return join(directory, 'bin', file);
}

interface LauncherRun {
  platform: string;
  arch: string;
  binaries?: { name: string; marker: string }[];
  platformPackage?: { name: string; file: string; marker: string };
  args: string[];
}

async function runLauncher({ platform, arch, binaries = [], platformPackage, args }: LauncherRun) {
  const packageRoot = await createPackage();

  await Bun.write(
    join(packageRoot, 'bootstrap.ts'),
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
Object.defineProperty(process, 'arch', { value: ${JSON.stringify(arch)} });

await import('./bin/agent-browser.ts');
`
  );
  for (const { name, marker } of binaries) {
    await writeFakeBinary(join(packageRoot, 'bin', name), marker);
  }
  if (platformPackage) {
    await writePlatformPackage(packageRoot, platformPackage.name, platformPackage.file, platformPackage.marker);
  }

  const result = Bun.spawnSync([process.execPath, join(packageRoot, 'bootstrap.ts'), ...args], {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const lines = (stdout: string) => stdout.trim().split('\n');

runsBinaries('Windows ARM64 launcher uses the published x64 executable', async () => {
  const args = ['open', 'https://example.com'];
  const result = await runLauncher({
    platform: 'win32',
    arch: 'arm64',
    binaries: [{ name: 'agent-browser-win32-x64.exe', marker: 'x64-binary-ran' }],
    args,
  });

  expect(result.status, result.stderr).toBe(0);
  expect(lines(result.stdout)).toEqual(['x64-binary-ran', ...args]);
  expect(result.stderr).not.toMatch(/No binary found/);
});

runsBinaries('Windows ARM64 launcher prefers an existing native executable', async () => {
  const args = ['--version'];
  const result = await runLauncher({
    platform: 'win32',
    arch: 'arm64',
    binaries: [
      { name: 'agent-browser-win32-arm64.exe', marker: 'arm64-binary-ran' },
      { name: 'agent-browser-win32-x64.exe', marker: 'x64-binary-ran' },
    ],
    args,
  });

  expect(result.status, result.stderr).toBe(0);
  expect(lines(result.stdout)).toEqual(['arm64-binary-ran', ...args]);
});

runsBinaries('Windows ARM64 launcher runs when only a source-built native executable exists', async () => {
  const args = ['snapshot'];
  const result = await runLauncher({
    platform: 'win32',
    arch: 'arm64',
    binaries: [{ name: 'agent-browser-win32-arm64.exe', marker: 'arm64-binary-ran' }],
    args,
  });

  expect(result.status, result.stderr).toBe(0);
  expect(lines(result.stdout)).toEqual(['arm64-binary-ran', ...args]);
  expect(result.stderr).not.toMatch(/No binary found/);
});

runsBinaries('macOS ARM64 launcher keeps selecting the ARM64 executable', async () => {
  const args = ['--version'];
  const result = await runLauncher({
    platform: 'darwin',
    arch: 'arm64',
    binaries: [{ name: 'agent-browser-darwin-arm64', marker: 'arm64-binary-ran' }],
    args,
  });

  expect(result.status, result.stderr).toBe(0);
  expect(lines(result.stdout)).toEqual(['arm64-binary-ran', ...args]);
});

runsBinaries('Linux launcher runs the binary from the platform package', async () => {
  const args = ['--version'];
  const result = await runLauncher({
    platform: 'linux',
    arch: 'x64',
    platformPackage: {
      name: '@agent-browser/cli-linux-x64-gnu',
      file: 'agent-browser',
      marker: 'platform-package-ran',
    },
    args,
  });

  expect(result.status, result.stderr).toBe(0);
  expect(lines(result.stdout)).toEqual(['platform-package-ran', ...args]);
});

runsBinaries('Windows launcher runs the binary from the platform package', async () => {
  const args = ['open', 'https://example.com'];
  const result = await runLauncher({
    platform: 'win32',
    arch: 'arm64',
    platformPackage: {
      name: '@agent-browser/cli-win32-x64-msvc',
      file: 'agent-browser.exe',
      marker: 'win32-package-ran',
    },
    args,
  });

  expect(result.status, result.stderr).toBe(0);
  expect(lines(result.stdout)).toEqual(['win32-package-ran', ...args]);
});

test('launcher reports a missing platform package', async () => {
  const result = await runLauncher({ platform: 'darwin', arch: 'arm64', args: ['--version'] });

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/@agent-browser\/cli-darwin-arm64/);
});

// The remaining tests run the launcher on the real host, the way a package
// manager's bin entry does, so they only apply where bin links are symlinks.

async function hostTarget(): Promise<NativeTarget> {
  const { nativeTarget } = await import('../scripts/native.ts');
  return nativeTarget()!;
}

runsBinaries('first run through a bin symlink relinks it to the native binary', async () => {
  const target = await hostTarget();
  const prefix = await tempDir('agent-browser-global-');
  const packageRoot = await createPackage(join(prefix, 'lib', 'node_modules', 'agent-browser'));
  await writePlatformPackage(packageRoot, target.packageName, target.file, 'native-ran');
  const entry = join(prefix, 'bin', 'agent-browser');
  await Bun.write(join(prefix, 'bin', '.keep'), '');
  await symlink('../lib/node_modules/agent-browser/bin/agent-browser.ts', entry);

  // A package manager's bin directory is on PATH, which is how the launcher finds the symlink it was started through.
  const env = { ...Bun.env, PATH: `${join(prefix, 'bin')}${delimiter}${Bun.env.PATH}` };
  const run = (...args: string[]) =>
    Bun.spawnSync([entry, ...args], { env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });

  const first = run('--version');
  expect(first.exitCode, first.stderr.toString()).toBe(0);
  expect(lines(first.stdout.toString())).toEqual(['native-ran', '--version']);

  // The link now targets a copy inside this package's own bin directory, so
  // package managers still recognize and remove it on uninstall.
  const linkedBinary = join(await realpath(packageRoot), 'bin', target.binaryName);
  expect(await readlink(entry)).toBe(linkedBinary);

  const second = run('snapshot');
  expect(second.exitCode, second.stderr.toString()).toBe(0);
  expect(lines(second.stdout.toString())).toEqual(['native-ran', 'snapshot']);
});

runsBinaries('linkNative leaves bin entries that do not target the launcher', async () => {
  const target = await hostTarget();
  const { linkNative } = await import('../scripts/link-native.ts');
  const packageRoot = await realpath(await createPackage());
  const binary = await writePlatformPackage(packageRoot, target.packageName, target.file, 'native-ran');

  const otherPackage = await createPackage();
  const foreignLink = join(packageRoot, 'foreign-link');
  await symlink(join(otherPackage, 'bin', 'agent-browser.ts'), foreignLink);
  const regularFile = join(packageRoot, 'regular-file');
  await Bun.write(regularFile, Bun.file(launcherPath));

  const changed = await linkNative({ packageRoot, binary, target, entries: [foreignLink, regularFile] });

  expect(changed).toBe(false);
  expect(await readlink(foreignLink)).toBe(join(otherPackage, 'bin', 'agent-browser.ts'));
  expect(await Bun.file(regularFile).text()).toBe(await Bun.file(launcherPath).text());
});

runsBinaries('linkNative rewrites the pnpm shim that runs this launcher', async () => {
  const target = await hostTarget();
  const { linkNative } = await import('../scripts/link-native.ts');
  const pnpmHome = await tempDir('agent-browser-pnpm-');
  const packageRoot = await createPackage(join(pnpmHome, 'global', 'v11', 'abc123', 'node_modules', 'agent-browser'));
  const binary = await writePlatformPackage(packageRoot, target.packageName, target.file, 'native-ran');
  const launcher = join(packageRoot, 'bin', 'agent-browser.ts');

  const shim = join(pnpmHome, 'bin', 'agent-browser');
  await writeExecutable(shim, `#!/bin/sh\nexec bun "${launcher}" "$@"\n# cmd-shim-target=${launcher}\n`);

  expect(await linkNative({ packageRoot, binary, target, entries: [launcher] })).toBe(true);
  const content = await Bun.file(shim).text();
  expect(content).toMatch(new RegExp(`^# cmd-shim-target=${escapeRegExp(launcher)}$`, 'm'));
  expect(content).not.toMatch(/exec bun/);

  const result = Bun.spawnSync([shim, '--version'], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(lines(result.stdout.toString())).toEqual(['native-ran', '--version']);
});

runsBinaries('linkNative leaves a pnpm shim for another target untouched', async () => {
  const target = await hostTarget();
  const { linkNative } = await import('../scripts/link-native.ts');
  const pnpmHome = await tempDir('agent-browser-pnpm-');
  const packageRoot = await createPackage(join(pnpmHome, 'global', 'v11', 'abc123', 'node_modules', 'agent-browser'));
  const binary = await writePlatformPackage(packageRoot, target.packageName, target.file, 'native-ran');

  const shim = join(pnpmHome, 'bin', 'agent-browser');
  const original =
    '#!/bin/sh\nexec bun "/elsewhere/agent-browser.ts" "$@"\n# cmd-shim-target=/elsewhere/agent-browser.ts\n';
  await writeExecutable(shim, original);

  await linkNative({ packageRoot, binary, target, entries: [join(packageRoot, 'bin', 'agent-browser.ts')] });
  expect(await Bun.file(shim).text()).toBe(original);
});
