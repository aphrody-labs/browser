import { expect, test } from "bun:test";
import { navigation } from "../src/lib/docs-navigation.ts";
import {
  baseline,
  pages,
  hash,
  canonical,
  assertModernMarkdown,
  assertContainsLines,
  currentPages,
  absoluteDestination,
  imageSourceUrls,
  assertOriginalResource,
  assertUntrackedHtml,
} from "./helpers.ts";

test("deployment uses Bun, not a pinned Node package manager", async () => {
  const [workspace, docs] = await Promise.all([
    Bun.file(new URL("../../package.json", import.meta.url)).json(),
    Bun.file(new URL("../package.json", import.meta.url)).json(),
  ]);
  expect(workspace.packageManager).toBeUndefined();
  expect(docs.packageManager).toBeUndefined();
  expect(workspace.engines?.node).toBeUndefined();
  expect(docs.engines?.node).toBeUndefined();
});

test("deployment uses the workspace lockfile without a stale docs override", async () => {
  expect(await Bun.file(new URL("../../bun.lock", import.meta.url)).exists()).toBe(true);
  expect(
    await Bun.file(new URL("../bun.lock", import.meta.url)).exists(),
    "A docs-local lockfile shadows the workspace lockfile during deployment",
  ).toBe(false);
});

test("deployment explicitly uses Bun for frozen installs and builds", async () => {
  const config = await Bun.file(new URL("../vercel.json", import.meta.url)).json();
  expect(config.installCommand).toBe("bun install --filter docs --frozen-lockfile");
  expect(config.buildCommand).toBe("bun run build");
});

test("baseline pins all 39 routes and the original metadata, slugger and converter sources", () => {
  expect(baseline.commit).toBe("efee3893d9080fcacb1aa6c9a21d13fbc6021f20");
  expect(pages.length).toBe(39);
  expect(new Set(pages.map((page) => page.path)).size).toBe(39);
  for (const path of [
    "docs/mdx-components.tsx",
    "docs/src/lib/mdx-to-markdown.ts",
    "docs/src/lib/page-metadata.ts",
    "docs/src/lib/page-titles.ts",
    "docs/src/app/layout.tsx",
    "docs/src/app/api/docs-markdown/route.ts",
    "docs/src/app/api/search/route.ts",
  ])
    expect(baseline.sources[path], path).toBeTruthy();
  for (const [path, source] of Object.entries(baseline.sources)) expect(hash(source.raw), path).toBe(source.sha256);
  for (const page of pages) {
    expect(hash(baseline.sources[page.source].raw), page.source).toBe(page.sourceSha256);
    expect(baseline.sources[page.layout], page.layout).toBeTruthy();
    expect(hash(page.legacyMarkdown), page.path).toBe(page.legacyMarkdownSha256);
    expect(hash(page.modernMarkdown), page.path).toBe(page.modernMarkdownSha256);
    expect(page.headings.filter((heading) => heading.level === 1).length, page.path).toBe(1);
    expect(page.content.length > 0, page.path).toBeTruthy();
  }
});

test("WebMCP appears once in Features after CDP Mode in both navigation sources", async () => {
  const meta = await Bun.file(new URL("../content/docs/meta.json", import.meta.url)).json();
  const reference = navigation.find((section) => section.title === "Reference");
  const features = navigation.find((section) => section.title === "Features");
  const featurePaths = features.items.map((item) => item.href);
  expect(navigation.flatMap((section) => section.items).filter((item) => item.href === "/webmcp").length).toBe(1);
  expect(!reference.items.some((item) => item.href === "/webmcp")).toBeTruthy();
  expect(featurePaths.includes("/webmcp")).toBeTruthy();
  expect(featurePaths.indexOf("/webmcp")).toBe(featurePaths.indexOf("/cdp-mode") + 1);
  expect(meta.pages.filter((page) => page === "webmcp").length).toBe(1);
  expect(meta.pages.indexOf("webmcp") > meta.pages.indexOf("---Features---")).toBeTruthy();
  expect(meta.pages.indexOf("webmcp")).toBe(meta.pages.indexOf("cdp-mode") + 1);
  const referenceSlugs = meta.pages.slice(
    meta.pages.indexOf("---Reference---") + 1,
    meta.pages.indexOf("---Features---"),
  );
  expect(referenceSlugs).toStrictEqual(reference.items.map((item) => item.href.slice(1)));
  expect(
    meta.pages.slice(meta.pages.indexOf("---Features---") + 1, meta.pages.indexOf("---Providers---")),
  ).toStrictEqual(featurePaths.map((href) => href.slice(1)));
});

test("heading oracle excludes fenced shell comments and preserves original duplicate IDs", () => {
  const quickStart = pages.find((page) => page.path === "/quick-start");
  expect(quickStart.headings.length).toBe(8);
  expect(!quickStart.headings.some((heading) => heading.text.includes("@e1"))).toBeTruthy();
  const diffing = pages.find((page) => page.path === "/diffing");
  expect(diffing.headings.filter((heading) => heading.id === "options").length).toBe(3);
  expect(diffing.headings.filter((heading) => heading.id === "output").length).toBe(2);
  const changelog = pages.find((page) => page.path === "/changelog");
  expect(changelog.headings.filter((heading) => heading.id === "bug-fixes").length).toBe(54);
  expect(changelog.headings.some((heading) => heading.level === 3)).toBeTruthy();
  expect(
    pages.find((page) => page.path === "/streaming").headings.filter((heading) => heading.id === "streaming").length,
  ).toBe(2);
});

test("legacy Markdown quirks are distinguished from the new lossless Markdown contract", () => {
  const browserbase = pages.find((page) => page.path === "/providers/browserbase");
  expect(browserbase.modernMarkdown.includes('export BROWSERBASE_API_KEY="your-api-key"')).toBeTruthy();
  expect(!browserbase.legacyMarkdown.includes('export BROWSERBASE_API_KEY="your-api-key"')).toBeTruthy();
  const diffing = pages.find((page) => page.path === "/diffing");
  expect(diffing.legacyMarkdown.includes("<DiffDemo />")).toBeTruthy();
  expect(!diffing.modernMarkdown.includes("<DiffDemo />")).toBeTruthy();
  const root = pages.find((page) => page.path === "/");
  expect(root.markdownTitle).toBe("agent-browser");
  expect(root.title).toBe("agent-browser | Browser Automation for AI");
});

test("Markdown oracle rejects missing tables, fenced export examples and nested sections", () => {
  for (const path of ["/configuration", "/providers/browserbase", "/diffing"]) {
    const page = pages.find((candidate) => candidate.path === path);
    const prefix = `---\ntitle: ${JSON.stringify(page.markdownTitle)}\ndescription: ${JSON.stringify(page.description)}\ncanonical_url: ${JSON.stringify(canonical(path))}\n---\n\n`;
    assertModernMarkdown(`${prefix}${page.modernMarkdown}\n`, page);
    const mutated = page.modernMarkdown.replace(/<table>[\s\S]*?<\/table>|^export .+$|^### .+$/m, "");
    expect(mutated).not.toBe(page.modernMarkdown);
    expect(() => assertModernMarkdown(`${prefix}${mutated}\n`, page)).toThrow();
  }
});

test("content floor accepts inserted lines and rejects edited or dropped ones", () => {
  const original = "| a | b |\n| - | - |\n| 1 | 2 |\n\n```bash\nfoo # one\nbar # two\n```";
  assertContainsLines(
    original.replace("| 1 | 2 |", "| 1 | 2 |\n| 3 | 4 |").replace("foo # one", "foo # one\nbaz # new"),
    original,
    "insert",
  );
  for (const mutated of [original.replace("bar # two", "bar # 2"), original.replace("| 1 | 2 |\n", "")])
    expect(() => assertContainsLines(mutated, original, "edit")).toThrow();
});

test("intentional docs edits apply to the live floor without touching the pinned baseline", () => {
  const original = pages.find((page) => page.path === "/proxy");
  const current = currentPages.find((page) => page.path === "/proxy");
  const before = "It is not supported on macOS or Windows.";
  expect(original.modernMarkdown.includes(before)).toBeTruthy();
  expect(!current.modernMarkdown.includes(before)).toBeTruthy();
  expect(
    current.content.some((sample) => sample.includes("where Chromium already uses the operating system trust store")),
  ).toBeTruthy();
});

test("link normalization preserves origin, path, query and fragment destinations", () => {
  const expected = absoluteDestination("https://agent-browser.dev/schema.json", "/configuration");
  expect(absoluteDestination("/schema.json", "/configuration")).toBe(expected);
  expect(absoluteDestination("../schema.json", "/providers/browserbase")).toBe(expected);
  for (const wrong of [
    "https://example.com/schema.json",
    "/other.json",
    "/schema.json?changed=1",
    "/schema.json#changed",
  ]) {
    expect(absoluteDestination(wrong, "/configuration")).not.toBe(expected);
  }
});

test("image assertions unwrap optimizer sources and inspect every responsive candidate", () => {
  const source = "/_next/static/media/contact-sheet-example.hash.png";
  const optimized = `/_next/image?url=${encodeURIComponent(source)}&w=640&q=75`;
  expect(
    imageSourceUrls(
      {
        src: optimized,
        srcset: `${optimized} 640w, ${optimized.replace("w=640", "w=1200")} 1200w`,
      },
      "/recording",
    ),
  ).toStrictEqual([absoluteDestination(source, "/recording")]);
  expect(imageSourceUrls({ src: source }, "/recording")).toStrictEqual([absoluteDestination(source, "/recording")]);
  expect(imageSourceUrls({ src: optimized, srcset: "/unrelated.png 1200w" }, "/recording")).toStrictEqual([
    absoluteDestination(source, "/recording"),
    absoluteDestination("/unrelated.png", "/recording"),
  ]);
  for (const src of [
    "https://example.com/image.png",
    "/_next/image?w=640",
    "/_next/image?url=https%3A%2F%2Fexample.com%2Fimage.png",
    "/_next/image?url=%2F_next%2Fimage",
  ]) {
    expect(() => imageSourceUrls({ src }, "/recording")).toThrow();
  }
});

test("image byte oracle rejects altered and truncated originals even when the alt text is unchanged", async () => {
  const resource = baseline.resources.find((entry) => entry.path === "/recording/contact-sheet-example.png");
  expect(resource).toBeTruthy();
  const bytes = Buffer.from(await Bun.file(new URL(`../public${resource.path}`, import.meta.url)).arrayBuffer());
  assertOriginalResource(bytes, resource);
  const mutated = Buffer.from(bytes);
  mutated[mutated.length - 1] ^= 1;
  expect(() => assertOriginalResource(mutated, resource)).toThrow();
  expect(() => assertOriginalResource(bytes.subarray(1), resource)).toThrow();
});

test("tracking oracle permits Flight serialization but rejects visible, canonical and metadata leakage", () => {
  const page = pages.find((entry) => entry.path === "/commands");
  const html = `<html><head><link rel="canonical" href="${canonical(page.path)}"><meta property="og:url" content="${canonical(page.path)}"><meta property="og:title" content="Commands"></head><body><main>Original content</main><script>self.__next_f.push([1, {c: ["commands?utm_source=route-test"], q: "?utm_source=route-test"}])</script></body></html>`;
  assertUntrackedHtml(html, page);
  for (const mutated of [
    html.replace("Original content", "Original content utm_source=route-test"),
    html.replace('content="Commands"', 'content="Commands route-test"'),
    html.replace(`href="${canonical(page.path)}"`, `href="${canonical(page.path)}?utm_source=route-test"`),
    html.replace(`content="${canonical(page.path)}"`, `content="${canonical(page.path)}?utm_source=route-test"`),
  ])
    expect(() => assertUntrackedHtml(mutated, page)).toThrow();
});
