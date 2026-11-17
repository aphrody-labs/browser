/**
 * Locates the native agent-browser binary for this host.
 *
 * Shared by bin/agent-browser.ts and scripts/postinstall.ts. Kept free of
 * subprocesses because the launcher imports it on every wrapped invocation.
 */

// Bun has no chmod API.
// eslint-disable-next-line import/no-nodejs-modules
import { chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Libc = 'glibc' | 'musl';

/**
 * Describes where the binary for a host can live:
 * - packageName/file: the per-platform optional dependency and its executable
 * - binaryName: the file name used inside this package's bin/ directory
 *   (postinstall download, source builds and linked installs)
 * - candidates: bin/ file names to try, in order
 */
export interface NativeTarget {
  packageName: string;
  file: string;
  binaryName: string;
  candidates: string[];
}

// Uses the process report instead of spawning `ldd`, which costs a shell startup on every call. The report lists no
// loaded libraries under Bun, so a musl host is recognised by its dynamic loader.
async function detectLibc(): Promise<Libc | null> {
  if (process.platform !== 'linux') return null;
  Object.assign(process.report, { excludeNetwork: true });
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string }; sharedObjects?: string[] };
  if (report.header.glibcVersionRuntime) return 'glibc';
  if (report.sharedObjects?.some((path) => /(?:^|\/)ld-musl-|libc\.musl-/.test(path))) return 'musl';
  const loaderArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return (await Bun.file(`/lib/ld-musl-${loaderArch}.so.1`).exists()) ? 'musl' : 'glibc';
}

const hostLibc = await detectLibc();

export function nativeTarget(
  os: string = process.platform,
  cpuArch: string = process.arch,
  libc: Libc | null = os === 'linux' ? hostLibc : null
): NativeTarget | null {
  let archKey: 'x64' | 'arm64';
  switch (cpuArch) {
    case 'x64':
    case 'x86_64':
      archKey = 'x64';
      break;
    case 'arm64':
    case 'aarch64':
      archKey = 'arm64';
      break;
    default:
      return null;
  }

  switch (os) {
    case 'darwin':
      return {
        packageName: `@agent-browser/cli-darwin-${archKey}`,
        file: 'agent-browser',
        binaryName: `agent-browser-darwin-${archKey}`,
        candidates: [`agent-browser-darwin-${archKey}`],
      };
    case 'linux': {
      const musl = libc === 'musl';
      const binaryName = `agent-browser-linux-${musl ? 'musl-' : ''}${archKey}`;
      return {
        packageName: `@agent-browser/cli-linux-${archKey}-${musl ? 'musl' : 'gnu'}`,
        file: 'agent-browser',
        binaryName,
        candidates: [binaryName],
      };
    }
    case 'win32':
      // Prefer a source-built native ARM64 executable when present. Otherwise,
      // use the published x64 binary through Windows' built-in emulation.
      return {
        packageName: '@agent-browser/cli-win32-x64-msvc',
        file: 'agent-browser.exe',
        binaryName: 'agent-browser-win32-x64.exe',
        candidates:
          archKey === 'arm64'
            ? ['agent-browser-win32-arm64.exe', 'agent-browser-win32-x64.exe']
            : ['agent-browser-win32-x64.exe'],
      };
    default:
      return null;
  }
}

// Returns the binary inside the installed platform package, or null.
export async function platformPackageBinary(packageRoot: string, target: NativeTarget): Promise<string | null> {
  let manifest: string;
  try {
    manifest = Bun.resolveSync(`${target.packageName}/package.json`, packageRoot);
  } catch {
    // The platform package is not installed: the caller falls back to bin/ or reports it.
    return null;
  }
  const binary = join(dirname(manifest), 'bin', target.file);
  return (await Bun.file(binary).exists()) ? binary : null;
}

// Returns the binary to run: a file already in bin/, else the platform package.
export async function findNativeBinary(packageRoot: string, target: NativeTarget): Promise<string | null> {
  for (const name of target.candidates) {
    const binary = join(packageRoot, 'bin', name);
    if (await Bun.file(binary).exists()) return binary;
  }
  return platformPackageBinary(packageRoot, target);
}

/** Restores the execute bit that a package manager may not have preserved (EACCES on macOS and Linux otherwise). */
export async function ensureExecutable(binary: string): Promise<void> {
  if (process.platform === 'win32') return;
  if (((await Bun.file(binary).stat()).mode & 0o111) !== 0) return;
  await chmod(binary, 0o755);
}
