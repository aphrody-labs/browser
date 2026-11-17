/**
 * Evaluates TypeScript sources that are not files on disk (the pinned original pages, read from git) as modules, with
 * every import either a sibling original module or an explicitly supplied stub. Any other import fails resolution.
 */

import { posix } from "node:path";

const prefix = "original:";
const sources = new Map<string, string>();
let readSource: (path: string) => string = () => "";
const stubs = new Map<string, Record<string, unknown>>();
let evaluations = 0;

Bun.plugin({
  name: "original-modules",
  setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
      if (path.startsWith(prefix)) return { path: path.slice(prefix.length), namespace: "original" };
      if (!importer.startsWith(prefix)) return undefined;
      const importerPath = importer.slice(prefix.length);
      const imports = stubs.get(importerPath) ?? {};
      if (Object.hasOwn(imports, path)) return { path: `${importerPath}::${path}`, namespace: "stub" };
      if (path.startsWith(".")) {
        return {
          path: `${posix.normalize(posix.join(posix.dirname(importerPath), path))}.ts`,
          namespace: "original",
        };
      }
      throw new Error(`Unapproved baseline import ${path} in ${importerPath}`);
    });
    build.onLoad({ filter: /.*/, namespace: "original" }, ({ path }) => ({
      contents: sources.get(path) ?? readSource(path),
      loader: path.endsWith(".tsx") ? "tsx" : "ts",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => {
      const split = path.indexOf("::");
      const importerPath = path.slice(0, split);
      const specifier = path.slice(split + 2);
      return { exports: stubs.get(importerPath)![specifier] as object, loader: "object" };
    });
  },
});

/** Supplies the source of a sibling original module that was not registered by `loadOriginal`. */
export function setSourceReader(read: (path: string) => string): void {
  readSource = read;
}

/** Runs `raw` as the module `filename`; `imports` maps each non-relative specifier it may import to its exports. */
export function evaluateOriginal<T>(raw: string, filename: string, imports: Record<string, unknown> = {}): Promise<T> {
  return loadOriginal(`~${evaluations++}/${filename}`, raw, imports);
}

/** Like `evaluateOriginal`, but the module keeps its path so that the originals it imports resolve by relative path. */
export function loadOriginal<T>(path: string, raw: string, imports: Record<string, unknown> = {}): Promise<T> {
  sources.set(path, raw);
  stubs.set(path, imports);
  return import(`${prefix}${path}`);
}
