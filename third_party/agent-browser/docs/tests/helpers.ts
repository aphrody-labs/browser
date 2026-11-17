import { expect } from "bun:test";

export const baseline = await Bun.file(new URL("fixtures/docs-baseline.json", import.meta.url)).json();
export const { pages } = baseline;
export const origin = "https://agent-browser.dev";
export const hash = (body) => new Bun.CryptoHasher("sha256").update(body).digest("hex");
export const canonical = (path) => `${origin}${path === "/" ? "" : path}`;
export const markdownPath = (path) => (path === "/" ? "/index.md" : `${path}.md`);
export const apiPath = (path) => `/api/docs-md${path === "/" ? "" : path}`;
export const tokens = (value) =>
  (value ?? "")
    .toLowerCase()
    .split(/\s*,\s*/)
    .filter(Boolean);
export const normalize = (value) => value.replace(/\s+/g, " ").trim();

/**
 * Intentional edits to original content since the pinned baseline. Each `from`
 * must still occur in the baseline page, so stale entries fail.
 */
const edits = await Bun.file(new URL("fixtures/docs-edits.json", import.meta.url)).json();

function applyEdits(page) {
  const pageEdits = edits.pages[page.path] ?? [];
  let { content, modernMarkdown, legacyMarkdown } = page;
  for (const { from, to } of pageEdits) {
    const found = [modernMarkdown, legacyMarkdown, ...content].some(
      (value) => value.includes(from) || normalize(value).includes(normalize(from)),
    );
    if (!found) throw new Error(`docs-edits.json: ${page.path} has no ${JSON.stringify(from)}`);
    modernMarkdown = modernMarkdown.replaceAll(from, to);
    legacyMarkdown = legacyMarkdown.replaceAll(from, to);
    content = content.map((sample) =>
      sample.includes(from)
        ? sample.replaceAll(from, to)
        : normalize(sample).replaceAll(normalize(from), normalize(to)),
    );
  }
  return { ...page, content, modernMarkdown, legacyMarkdown };
}

for (const path of Object.keys(edits.pages))
  if (!pages.some((page) => page.path === path)) throw new Error(`docs-edits.json: unknown page ${path}`);

/** Baseline pages with intentional edits applied: the floor for live routes. */
export const currentPages = pages.map(applyEdits);

/**
 * Pages added after the baseline was pinned. They have no baseline fixture, so
 * they carry only the metadata the shared path checks read, and they belong to
 * the public route inventory that the route suite audits.
 */
export const addedPages = [
  {
    path: "/modern-web-guidance",
    markdownTitle: "Modern Web Guidance",
    title: "Modern Web Guidance | agent-browser",
    description: "Browser automation CLI for AI agents",
    ogTitle: "Modern Web Guidance | agent-browser",
    ogDescription: "Browser automation CLI for AI agents",
    ogAlt: "Modern Web Guidance - agent-browser",
    twitterTitle: "Modern Web Guidance | agent-browser",
  },
];

/** Every public page: the baseline floor plus pages added since. */
export const publicPages = [...currentPages, ...addedPages];

/**
 * Public pages with a pinned baseline fixture. `navigation` is a fixture field,
 * so it separates pages whose original content, Markdown and search results are
 * recorded from pages added since, which only get the path checks.
 */
export const fixturePages = publicPages.filter((page) => page.navigation);

/** Baseline resources with intentionally changed bytes replaced. */
export const currentResources = baseline.resources.map((resource) => ({
  ...resource,
  ...edits.resources[resource.path],
}));
export const decode = (value) =>
  value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    if (entity.startsWith("#"))
      return String.fromCodePoint(
        entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)),
      );
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[entity.toLowerCase()];
  });
export const text = (html) =>
  normalize(decode(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "")));
export const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [
      match[1].toLowerCase(),
      decode(match[2] ?? match[3]),
    ]),
  );
export const tags = (html, name) =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(([tag]) => attributes(tag));
export const meta = (html, key) =>
  tags(html, "meta")
    .filter((tag) => tag.name === key || tag.property === key)
    .map((tag) => tag.content);
export const renderedHeadings = (html) =>
  [...html.matchAll(/<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)].map((match) => ({
    level: Number(match[1]),
    text: text(match[3]).replace(/\s*#$/, ""),
    id: attributes(match[2]).id ?? null,
  }));

export const absoluteDestination = (href, pagePath) => new URL(href, canonical(pagePath)).href;
export function imageSourceUrls(image, pagePath) {
  expect(typeof image.src, "image must expose a source URL").toBe("string");
  const candidates = [
    image.src,
    ...(image.srcset ? image.srcset.split(",").map((entry) => entry.trim().split(/\s+/)[0]) : []),
  ];
  return [
    ...new Set(
      candidates.map((candidate) => {
        const url = new URL(absoluteDestination(candidate, pagePath));
        expect(url.origin, "original local images must not move to an unrelated origin").toBe(origin);
        if (url.pathname !== "/_next/image") return url.href;
        const source = url.searchParams.get("url");
        expect(source, "Next image optimizer must specify its underlying resource").toBeTruthy();
        const underlying = new URL(source, origin);
        expect(underlying.origin, "optimized images must resolve to a local original resource").toBe(origin);
        expect(underlying.pathname, "do not recursively unwrap optimizer URLs").not.toBe("/_next/image");
        return underlying.href;
      }),
    ),
  ];
}
export function assertOriginalResource(bytes, resource) {
  expect(bytes.length, `${resource.source}: original byte length`).toBe(resource.size);
  expect(hash(bytes), `${resource.source}: original SHA-256`).toBe(resource.sha256);
}
export function assertUntrackedHtml(html, page) {
  expect(
    tags(html, "link")
      .filter((tag) => tag.rel === "canonical")
      .map((tag) => tag.href),
  ).toStrictEqual([canonical(page.path)]);
  expect(meta(html, "og:url")).toStrictEqual([canonical(page.path)]);
  const surfaces = [text(html), JSON.stringify(tags(html, "meta")), JSON.stringify(tags(html, "link"))];
  for (const marker of ["utm_source", "route-test"]) {
    for (const surface of surfaces)
      expect(
        !surface.includes(marker),
        `${page.path}: tracking leaked into visible text, metadata or document links`,
      ).toBeTruthy();
  }
}

export function get(path, options = {}) {
  expect(Bun.env.DOCS_TEST_URL, "Run bun scripts/test-routes.ts after building docs").toBeTruthy();
  return fetch(new URL(path, Bun.env.DOCS_TEST_URL), {
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
    ...options,
    headers: {
      "user-agent": "Mozilla/5.0",
      accept: "text/html",
      ...options.headers,
    },
  });
}
/** A GET sent as written on a raw socket, so that malformed paths reach the server unnormalized by fetch. */
export async function rawGet(path, headers = {}, method = "GET") {
  const url = new URL(Bun.env.DOCS_TEST_URL);
  const secure = url.protocol === "https:";
  const request = [
    `${method} ${path} HTTP/1.1`,
    `host: ${url.host}`,
    "connection: close",
    ...Object.entries({ "user-agent": "Mozilla/5.0", accept: "text/html", ...headers }).map(
      ([name, value]) => `${name}: ${value}`,
    ),
    "",
    "",
  ].join("\r\n");
  const received = [];
  const closed = Promise.withResolvers();
  const socket = await Bun.connect({
    hostname: url.hostname,
    port: Number(url.port) || (secure ? 443 : 80),
    tls: secure,
    socket: {
      open: (connection) => void connection.write(request),
      data: (_connection, chunk) => void received.push(chunk),
      close: () => closed.resolve(),
      error: (_connection, error) => closed.reject(error),
      connectError: (_connection, error) => closed.reject(error),
    },
  });
  const timeout = setTimeout(() => closed.reject(new Error(`${method} ${path} timed out`)), 30000);
  try {
    await closed.promise;
  } finally {
    clearTimeout(timeout);
    socket.end();
  }
  return parseResponse(Buffer.concat(received), method);
}

function parseResponse(bytes, method) {
  const split = bytes.indexOf("\r\n\r\n");
  expect(split, "incomplete HTTP response").toBeGreaterThan(0);
  const [statusLine, ...lines] = bytes.subarray(0, split).toString("latin1").split("\r\n");
  const status = Number(statusLine.split(" ")[1]);
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  let body = bytes.subarray(split + 4);
  if (/chunked/i.test(headers.get("transfer-encoding") ?? "")) {
    const decoded = [];
    let offset = 0;
    for (;;) {
      const lineEnd = body.indexOf("\r\n", offset);
      const size = Number.parseInt(body.subarray(offset, lineEnd).toString("latin1"), 16);
      if (!size) break;
      decoded.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
      offset = lineEnd + 2 + size + 2;
    }
    body = Buffer.concat(decoded);
    headers.delete("transfer-encoding");
  }
  return new Response(method === "HEAD" || body.length === 0 ? null : body, { status, headers });
}
export function responseType(response, expected, status = 200) {
  expect(response.status, response.url).toBe(status);
  expect(response.headers.get("content-type")?.split(";")[0], response.url).toBe(expected);
}
export function representationHeaders(response) {
  const vary = tokens(response.headers.get("vary"));
  for (const input of [
    "accept",
    "user-agent",
    "signature-agent",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "rsc",
    "next-router-state-tree",
    "next-router-prefetch",
    "next-router-segment-prefetch",
    "next-url",
    "purpose",
    "sec-purpose",
  ]) {
    expect(vary.includes(input), `${response.url}: Vary missing ${input}: ${vary}`).toBeTruthy();
  }
  expect(!vary.includes("*"), "Vary must explicitly retain every negotiation and Next input").toBeTruthy();
  const cache = tokens(response.headers.get("cache-control"));
  expect(cache.includes("private") && cache.includes("no-store"), `${response.url}: ${cache}`).toBeTruthy();
  expect(!cache.includes("public") && !cache.some((token) => /^(s-maxage|max-age)=[1-9]/.test(token))).toBeTruthy();
  for (const name of ["cdn-cache-control", "vercel-cdn-cache-control"])
    expect(response.headers.get(name), `${response.url}: ${name}`).toBe("no-store");
  expect(response.headers.get("set-cookie"), `${response.url}: no locale cookies`).toBe(null);
}
export function indexing(response, html, missing = false) {
  const noindex = Bun.env.DOCS_EXPECT_NOINDEX === "1" || missing;
  const header = tokens(response.headers.get("x-robots-tag"));
  const robots = html === undefined ? [] : meta(html, "robots").flatMap(tokens);
  if (noindex) {
    expect(header.includes("noindex"), `${response.url}: missing X-Robots-Tag noindex`).toBeTruthy();
    if (html !== undefined)
      expect(robots.includes("noindex"), `${response.url}: missing robots meta noindex`).toBeTruthy();
  } else {
    expect(
      ![...header, ...robots].some((value) => ["noindex", "nofollow", "none"].includes(value)),
      `${response.url}: unexpectedly unindexable`,
    ).toBeTruthy();
  }
}
/** Every non-blank line of `original` appears in `body`, in order. New lines may appear anywhere. */
export function assertContainsLines(body, original, label) {
  let from = 0;
  for (const line of original.split("\n").filter((l) => l.trim())) {
    const at = body.indexOf(line, from);
    expect(at !== -1, `${label}: lost original line ${JSON.stringify(line.slice(0, 80))}`).toBeTruthy();
    from = at + line.length;
  }
}

export function assertModernMarkdown(body, page) {
  const frontmatter = `---\ntitle: ${JSON.stringify(page.markdownTitle)}\ndescription: ${JSON.stringify(page.description)}\ncanonical_url: ${JSON.stringify(canonical(page.path))}\n---\n\n`;
  expect(body.startsWith(frontmatter), `${page.path}: exact canonical frontmatter`).toBeTruthy();
  assertContainsLines(
    body.slice(frontmatter.length),
    page.modernMarkdown,
    `${page.path}: original body, preserving fenced export/import examples`,
  );
}

export function assertLegacyMarkdown(body, page) {
  expect(!body.startsWith("---\n"), `${page.path}: legacy Markdown has no frontmatter`).toBeTruthy();
  assertContainsLines(body, page.legacyMarkdown, `${page.path}: legacy Markdown`);
}
