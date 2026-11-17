import { dirname, relative } from 'node:path';

export const rootDir = dirname(import.meta.dir);

export const toRelative = (path: string): string => relative(rootDir, path).replaceAll('\\', '/');

/**
 * Directory of the Rust crate named agent-browser: `cli` in the upstream repository, `agent-browser` once the crate is
 * imported into a monorepo.
 */
export async function findCliDir(): Promise<string> {
  for await (const manifest of new Bun.Glob('*/Cargo.toml').scan({ cwd: rootDir, absolute: true })) {
    if (/^name\s*=\s*"agent-browser"/m.test(await Bun.file(manifest).text())) return dirname(manifest);
  }
  throw new Error(`No directory under ${rootDir} holds the Cargo.toml of the agent-browser crate`);
}
