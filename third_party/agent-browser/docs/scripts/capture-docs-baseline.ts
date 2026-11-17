#!/usr/bin/env bun

import { resolve } from "node:path";
import { parse } from "@babel/parser";
import { createProcessor } from "@mdx-js/mdx";
import { assert, assertEqual } from "./assert.ts";
import { evaluateOriginal, loadOriginal, setSourceReader } from "./original-modules.ts";

const commit = "efee3893d9080fcacb1aa6c9a21d13fbc6021f20";
const root = resolve(import.meta.dir, "..", "..");
const output = Bun.file(new URL("../tests/fixtures/docs-baseline.json", import.meta.url));
function git(...args: string[]): Buffer {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout;
}
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const sources: Record<string, { sha256: string; raw: string }> = {};
function original(path: string): string {
  if (!sources[path]) {
    const raw = git("show", `${commit}:${path}`).toString("utf8");
    sources[path] = { sha256: hash(raw), raw };
  }
  return sources[path].raw;
}
setSourceReader(original);
const evaluate = <T = Record<string, unknown>>(raw: string, filename: string, imports: Record<string, unknown> = {}) =>
  evaluateOriginal<T>(raw, filename, imports);
const load = <T = Record<string, unknown>>(path: string) => loadOriginal<T>(path, original(path));
type Position = { start: { offset: number }; end: { offset: number } };
type AstNode = {
  type: string;
  value?: string;
  depth?: number;
  name?: string;
  url?: string;
  alt?: string;
  children?: AstNode[];
  attributes?: { name: string; position: Position }[];
  position: Position;
  data?: { estree?: { body?: { expression?: { type: string; value?: unknown } }[] } };
  id?: { type: string; name: string };
  init?: { start: number; end: number };
};
type Metadata = {
  title: string | { default: string; template: string };
  description: string;
  openGraph: { title: string; description: string; images: { alt: string }[] };
  twitter: { title: string };
};
type NavigationSection = { title?: string; items: { name: string; href: string }[] };
function initializer(raw: string, name: string, filename: string): string {
  const file = parse(raw, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: ["typescript", "jsx"],
  });
  let result: string | undefined;
  function visit(node: unknown): void {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof (node as AstNode).type !== "string") return;
    const ast = node as AstNode;
    if (ast.type === "VariableDeclarator" && ast.id.type === "Identifier" && ast.id.name === name) {
      result = raw.slice(ast.init.start, ast.init.end);
    }
    for (const [key, value] of Object.entries(ast)) {
      if (!["loc", "leadingComments", "trailingComments"].includes(key))
        if (value && typeof value === "object") visit(value);
    }
  }
  visit(file.program);
  assert(result, `${filename}: ${name}`);
  return result;
}
const componentSource = original("docs/mdx-components.tsx");
const headingFunctions = componentSource.slice(
  componentSource.indexOf("function slugify"),
  componentSource.indexOf("export function useMDXComponents"),
);
const { slugify, extractText } = await evaluate<{
  slugify: (text: string) => string;
  extractText: (node: unknown) => string;
}>(`${headingFunctions}\nexport { slugify, extractText };`, "original-heading-functions.ts");
const { mdxToCleanMarkdown } = await load<{ mdxToCleanMarkdown: (raw: string) => string }>(
  "docs/src/lib/mdx-to-markdown.ts",
);
const { PAGE_TITLES } = await load<{ PAGE_TITLES: Record<string, string> }>("docs/src/lib/page-titles.ts");
const { pageMetadata } = await load<{ pageMetadata: (slug: string) => Metadata }>("docs/src/lib/page-metadata.ts");
const { navigation } = await load<{ navigation: NavigationSection[] }>("docs/src/lib/docs-navigation.ts");
const rootPath = "docs/src/app/layout.tsx";
const rootMetadata = (
  await evaluate<{ value: Metadata }>(
    `export const value = ${initializer(original(rootPath), "metadata", rootPath)};`,
    rootPath,
  )
).value;
const parser = createProcessor();
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
function reactChildren(node: AstNode): unknown {
  if (["text", "inlineCode"].includes(node.type)) return node.value;
  if (node.type === "break") return "\n";
  if (node.type === "mdxTextExpression") {
    if (node.value.trim() === "") return "";
    const expression = node.data?.estree?.body?.[0]?.expression;
    assertEqual(expression?.type, "Literal", "Only literal MDX expressions can be captured");
    return expression.value;
  }
  return { props: { children: (node.children ?? []).map(reactChildren) } };
}
const nodeText = (node: AstNode): string => extractText(reactChildren(node));
function walk(node: AstNode, callback: (node: AstNode) => void): void {
  callback(node);
  for (const child of node.children ?? []) walk(child, callback);
}
function containsTable(node: AstNode): boolean {
  return ["table", "thead", "tbody", "tr", "td", "th"].includes(node.name) || (node.children ?? []).some(containsTable);
}
const files = git("ls-tree", "-r", "--name-only", commit, "docs/src/app")
  .toString()
  .trim()
  .split("\n")
  .filter((path) => path.endsWith("/page.mdx"))
  .sort();
assertEqual(files.length, 39, "Pinned commit must contain exactly 39 public pages");
const pages = files.map((source) => {
  const raw = original(source);
  const path = source.slice("docs/src/app".length).replace(/\/page\.mdx$/, "") || "/";
  const slug = path === "/" ? "" : path.slice(1);
  assert(Object.hasOwn(PAGE_TITLES, slug), source);
  const layout = path === "/" ? rootPath : source.replace(/page\.mdx$/, "layout.tsx");
  if (path !== "/") {
    const call = initializer(original(layout), "metadata", layout);
    assertEqual(call, `pageMetadata(${JSON.stringify(slug)})`, layout);
  }
  const metadata = path === "/" ? rootMetadata : pageMetadata(slug);
  const tree = parser.parse(raw);
  const headings = [];
  const content = [];
  const links = [];
  const edits = [];
  let h1;
  walk(tree, (node) => {
    if (node.type === "heading") {
      const text = nodeText(node);
      headings.push({
        level: node.depth,
        text,
        id: node.depth <= 3 ? slugify(text) : null,
      });
      if (node.depth === 1) {
        assertEqual(h1, undefined, `${source}: multiple H1s`);
        h1 = node;
      }
    }
    if (
      (node.type === "paragraph" && !containsTable(node)) ||
      (node.type.startsWith("mdxJsx") && ["td", "th", "p"].includes(node.name))
    ) {
      const text = normalize(nodeText(node));
      if (text) content.push(text);
    }
    if (node.type === "code") content.push(normalize(node.value));
    if (["link", "image"].includes(node.type))
      links.push({
        type: node.type,
        url: node.url,
        text: node.alt ?? nodeText(node),
      });
    if (node.type === "mdxjsEsm" || (node.type.startsWith("mdxJsx") && node.name === "DiffDemo")) {
      const end = node.position.end.offset;
      edits.push([node.position.start.offset, end + (raw[end] === "\n" ? 1 : 0), ""]);
    }
    for (const attr of node.attributes ?? []) {
      if (attr.name === "className") edits.push([attr.position.start.offset - 1, attr.position.end.offset, ""]);
    }
  });
  assert(h1, `${source}: missing H1`);
  let modernMarkdown = raw;
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) {
    modernMarkdown = modernMarkdown.slice(0, start) + replacement + modernMarkdown.slice(end);
  }
  const title = nodeText(h1);
  const og = metadata.openGraph;
  const nav = navigation
    .flatMap((section) => section.items.map((item) => ({ ...item, section: section.title ?? "" })))
    .find((item) => item.href === path);
  assert(nav, `${source}: navigation entry`);
  return {
    path,
    source,
    layout,
    sourceSha256: hash(raw),
    h1InsertionOffset: h1.position.start.offset,
    h1Source: raw.slice(h1.position.start.offset, h1.position.end.offset) + "\n",
    markdownTitle: title,
    title: path === "/" ? rootMetadata.title.default : rootMetadata.title.template.replace("%s", metadata.title),
    description: rootMetadata.description,
    ogTitle: og.title,
    ogDescription: og.description,
    ogAlt: og.images[0].alt,
    twitterTitle: metadata.twitter.title,
    headings,
    content: [...new Set(content)],
    links,
    legacyMarkdown: mdxToCleanMarkdown(raw),
    legacyMarkdownSha256: hash(mdxToCleanMarkdown(raw)),
    modernMarkdown: modernMarkdown.trim(),
    modernMarkdownSha256: hash(modernMarkdown.trim()),
    navigation: { title: nav.name, section: nav.section },
  };
});
const searchIndexPath = "docs/src/lib/search-index.ts";
const searchIndexSource = original(searchIndexPath);
const stripStart = searchIndexSource.indexOf("function stripMarkdown");
const stripEnd = searchIndexSource.indexOf("function mdxFileForSlug");
const { stripMarkdown } = await evaluate<{ stripMarkdown: (markdown: string) => string }>(
  `${searchIndexSource.slice(stripStart, stripEnd)}\nexport { stripMarkdown };`,
  searchIndexPath,
);
const searchIndex = navigation.flatMap((section) =>
  section.items.map((item) => ({
    title: item.name,
    href: item.href,
    section: section.title ?? "",
    content: stripMarkdown(pages.find((page) => page.path === item.href).legacyMarkdown),
  })),
);
const searchRoutePath = "docs/src/app/api/search/route.ts";
const { GET } = await evaluate<{ GET: (request: { nextUrl: URL }) => Promise<unknown> }>(
  original(searchRoutePath),
  searchRoutePath,
  {
    "next/server": {
      NextResponse: { json: (body) => JSON.parse(JSON.stringify(body)) },
    },
    "@/lib/search-index": { getSearchIndex: async () => searchIndex },
  },
);
original("docs/src/app/api/docs-markdown/route.ts");
const legacySearch: { query: string | null; response: unknown }[] = [];
for (const query of [
  null,
  "",
  "   ",
  "zzzyyy-nonexistent-123456",
  "installation",
  "snapshot",
  "  SNAPSHOT  ",
  "browser automation",
  "restoreCheckFn",
  "WebRTC",
  "ffmpeg",
]) {
  const nextUrl = new URL("https://agent-browser.dev/api/search");
  if (query !== null) nextUrl.searchParams.set("q", query);
  legacySearch.push({ query, response: await GET({ nextUrl }) });
}
const resources = git("ls-tree", "-r", "--name-only", commit, "docs/public", "docs/src/app/favicon.ico")
  .toString()
  .trim()
  .split("\n")
  .map((source) => {
    const bytes = git("show", `${commit}:${source}`);
    return {
      source,
      path: source === "docs/src/app/favicon.ico" ? "/favicon.ico" : source.replace("docs/public", ""),
      sha256: hash(bytes),
      size: bytes.length,
    };
  });
const serialized = `${JSON.stringify(
  {
    commit,
    policy:
      "Only git objects at the pinned commit are inputs. Modern Markdown removes AST-level MDX imports, DiffDemo and presentation className attributes; fenced code is preserved. Legacy Markdown executes the original converter verbatim, including its removal of export/import lines inside fences. Heading IDs execute the original slugify/extractText without deduplication. Root metadata comes from the root layout; child metadata comes from each original layout and pageMetadata/PAGE_TITLES.",
    sources,
    pages,
    legacySearch,
    resources,
  },
  null,
  2,
)}\n`;
if (Bun.argv.includes("--check")) {
  assertEqual(await output.text(), serialized, "Baseline is not reproducible from aff6125");
  console.log(`PASS: ${pages.length} fixtures reproduce exactly from ${commit}`);
} else {
  assertEqual(Bun.argv.slice(2), [], "Only --check is supported; the baseline commit cannot be overridden");
  await Bun.write(output, serialized);
  console.log(
    `Captured ${pages.length} original pages and ${Object.keys(sources).length} original source files at ${commit}`,
  );
}
