import { expect, test } from "bun:test";
import {
  fixturePages,
  publicPages,
  currentResources,
  origin,
  hash,
  canonical,
  markdownPath,
  apiPath,
  text,
  normalize,
  decode,
  tags,
  meta,
  renderedHeadings,
  get,
  rawGet,
  responseType,
  representationHeaders,
  indexing,
  assertModernMarkdown,
  assertLegacyMarkdown,
  absoluteDestination,
  imageSourceUrls,
  assertOriginalResource,
  assertUntrackedHtml,
} from "./helpers.ts";

expect(Bun.env.DOCS_TEST_URL, "Run bun scripts/test-routes.ts after a production build").toBeTruthy();
const noindex = Bun.env.DOCS_EXPECT_NOINDEX === "1";
const query = "?utm_source=route-test&value=a%2Fb&value=two";
const agent = { "user-agent": "ClaudeBot/1.0", accept: "text/markdown" };
const pageAt = (path) => publicPages.find((page) => page.path === path);
const legacyPath = (path) => `/api/docs-markdown?path=${encodeURIComponent(path)}`;
const htmlCache = new Map();
async function htmlFor(page) {
  if (!htmlCache.has(page.path))
    htmlCache.set(
      page.path,
      (async () => {
        const response = await get(page.path);
        responseType(response, "text/html");
        representationHeaders(response);
        const html = await response.text();
        indexing(response, html);
        return html;
      })(),
    );
  return htmlCache.get(page.path);
}

for (const page of publicPages) {
  test(`${page.path}: original title, description, OG and Twitter metadata plus canonical links`, async () => {
    const html = await htmlFor(page);
    expect([...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((match) => text(match[1]))).toStrictEqual([
      page.title,
    ]);
    expect(meta(html, "description")).toStrictEqual([page.description]);
    expect(tags(html, "html").map((tag) => tag.lang)).toStrictEqual(["en"]);
    for (const [key, expected] of Object.entries({
      "og:title": page.ogTitle,
      "og:description": page.ogDescription,
      "og:url": canonical(page.path),
      "og:type": "website",
      "og:site_name": "agent-browser",
      "og:locale": "en_US",
      "og:image": `${origin}/og${page.path === "/" ? "" : page.path}`,
      "og:image:width": "1200",
      "og:image:height": "630",
      "og:image:alt": page.ogAlt,
      "twitter:card": "summary_large_image",
      "twitter:title": page.twitterTitle,
      "twitter:description": page.description,
      "twitter:image": `${origin}/og${page.path === "/" ? "" : page.path}`,
    }))
      expect(meta(html, key), `${page.path}: ${key}`).toStrictEqual([expected]);
    expect(
      tags(html, "link")
        .filter((tag) => tag.rel === "canonical")
        .map((tag) => tag.href),
    ).toStrictEqual([canonical(page.path)]);
    expect(
      tags(html, "link")
        .filter((tag) => tag.rel === "alternate" && tag.type === "text/markdown")
        .map((tag) => tag.href),
    ).toStrictEqual([`${origin}${markdownPath(page.path)}`]);
  });
}

for (const page of fixturePages) {
  test(`${page.path}: original prose, every table cell, code example and link are server rendered`, async () => {
    const html = await htmlFor(page);
    expect(tags(html, "main").length).toBe(1);
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
    expect(main, "content must be in main, not only serialized in Flight scripts").toBeTruthy();
    const visible = text(main);
    for (const sample of page.content)
      expect(visible.includes(normalize(sample)), `${page.path}: SSR lost ${JSON.stringify(sample)}`).toBeTruthy();
    const hrefs = new Set(
      tags(main, "a")
        .filter((tag) => typeof tag.href === "string")
        .map((tag) => absoluteDestination(tag.href, page.path)),
    );
    for (const link of page.links.filter((link) => link.type === "link"))
      expect(
        hrefs.has(absoluteDestination(link.url, page.path)),
        `${page.path}: lost link destination ${link.url}`,
      ).toBeTruthy();
    for (const image of page.links.filter((link) => link.type === "image")) {
      const rendered = tags(main, "img").filter((tag) => tag.alt === image.text);
      expect(rendered.length, `${page.path}: expected original image alt ${image.text}`).toBe(1);
      const resource = currentResources.find(
        (entry) => absoluteDestination(entry.path, page.path) === absoluteDestination(image.url, page.path),
      );
      expect(resource, `${page.path}: missing original resource fixture for ${image.url}`).toBeTruthy();
      for (const source of imageSourceUrls(rendered[0], page.path)) {
        const url = new URL(source);
        const response = await get(`${url.pathname}${url.search}`, {
          headers: agent,
        });
        expect(response.status, source).toBe(200);
        expect(response.headers.get("content-type") ?? "").toMatch(/^image\//);
        assertOriginalResource(Buffer.from(await response.arrayBuffer()), resource);
      }
    }
  });

  test(`${page.path}: API, .md and negotiated Markdown serve the original content`, async () => {
    const bodies = [];
    for (const [path, headers] of [
      [apiPath(page.path), {}],
      [markdownPath(page.path), {}],
      [page.path, { accept: "text/markdown" }],
    ]) {
      const response = await get(path, { headers });
      responseType(response, "text/markdown");
      representationHeaders(response);
      indexing(response);
      expect(response.headers.get("link")).toBe(`<${canonical(page.path)}>; rel="canonical"`);
      const body = await response.text();
      assertModernMarkdown(body, page);
      bodies.push(body);
    }
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
  });

  test(`${page.path}: legacy ?path= API serves the original bare Markdown`, async () => {
    const response = await get(legacyPath(page.path));
    responseType(response, "text/markdown");
    representationHeaders(response);
    indexing(response);
    assertLegacyMarkdown(await response.text(), page);
  });
}

for (const page of publicPages) {
  test(`${page.path}: HEAD preserves all five representations without a response body`, async () => {
    for (const [path, headers, type] of [
      [page.path, {}, "text/html"],
      [apiPath(page.path), {}, "text/markdown"],
      [markdownPath(page.path), {}, "text/markdown"],
      [page.path, { accept: "text/markdown" }, "text/markdown"],
      [legacyPath(page.path), {}, "text/markdown"],
    ]) {
      const response = await get(path, { method: "HEAD", headers });
      responseType(response, type);
      representationHeaders(response);
      indexing(response);
      expect(await response.text()).toBe("");
      if (type === "text/markdown" && !path.startsWith("/api/docs-markdown?"))
        expect(response.headers.get("link")).toBe(`<${canonical(page.path)}>; rel="canonical"`);
    }
  });
}

for (const [name, headers, type] of [
  ["q=0 excludes Markdown", { accept: "text/markdown;q=0, text/html" }, "text/html"],
  ["HTML has higher quality", { accept: "text/markdown;q=0.5, text/html;q=1" }, "text/html"],
  ["Markdown has higher quality", { accept: "text/html;q=0.5, text/markdown;q=1" }, "text/markdown"],
  ["ordinary wildcard", { accept: "*/*" }, "text/html"],
  ...["Slackbot-LinkExpanding 1.0", "Discordbot/2.0", "Googlebot/2.1", "Twitterbot/1.0"].map((ua) => [
    ua,
    { "user-agent": ua, accept: "*/*" },
    "text/html",
  ]),
  ["ClaudeBot", { "user-agent": "ClaudeBot/1.0", accept: "*/*" }, "text/markdown"],
  [
    "browser navigation beats agent detection",
    {
      "user-agent": "ClaudeBot/1.0",
      accept: "*/*",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
    "text/html",
  ],
  [
    "explicit Markdown still works during navigation",
    { ...agent, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    "text/markdown",
  ],
  ...["next-router-prefetch", "next-router-segment-prefetch", "purpose", "sec-purpose"].map((header) => [
    `${header} bypasses Markdown`,
    {
      ...agent,
      [header]: header === "next-router-segment-prefetch" ? "/_tree" : header.startsWith("next-") ? "1" : "prefetch",
    },
    "text/html",
  ]),
  ["agent RSC stays Flight", { ...agent, rsc: "1" }, "text/x-component"],
  ["ordinary RSC stays Flight", { accept: "text/html", rsc: "1" }, "text/x-component"],
]) {
  test(`negotiation: ${name}`, async () => {
    const path = type === "text/x-component" ? "/commands?_rsc" : "/commands";
    const response = await rawGet(path, headers);
    responseType(response, type);
    representationHeaders(response);
    indexing(response);
    const body = await response.text();
    if (type === "text/html") {
      expect(tags(body, "html").length).toBe(1);
      expect(meta(body, "og:title")).toStrictEqual([pageAt("/commands").ogTitle]);
    }
    if (type === "text/markdown") assertModernMarkdown(body, pageAt("/commands"));
    if (type === "text/x-component") {
      expect(body.length > 0).toBeTruthy();
      expect(!body.startsWith("---\n") && !body.includes("<!DOCTYPE html>")).toBeTruthy();
      expect(body).toMatch(/(?:^|\n)[0-9a-f]+:/i);
    }
  });
}

test("invalid RSC cachebusters redirect to the valid Flight URL without changing representation", async () => {
  for (const headers of [
    { ...agent, rsc: "1" },
    { accept: "text/html", rsc: "1" },
  ]) {
    const response = await rawGet("/commands?_rsc=regression", headers);
    expect(response.status).toBe(307);
    representationHeaders(response);
    indexing(response);
    expect(response.headers.get("location")).toBe("/commands?_rsc");
    expect(await response.text()).toBe("");
    const destination = await rawGet(response.headers.get("location"), headers);
    responseType(destination, "text/x-component");
    representationHeaders(destination);
    indexing(destination);
    const body = await destination.text();
    expect(body).toMatch(/(?:^|\n)[0-9a-f]+:/i);
    expect(!body.startsWith("---\n") && !body.includes("<!DOCTYPE html>")).toBeTruthy();
  }
});

test("alternating representations and queries never contaminate one another", async () => {
  for (const path of ["/", "/commands", "/providers/browserbase"]) {
    const page = pageAt(path);
    const untracked = await htmlFor(page);
    for (const accept of ["text/markdown", "text/html", "text/markdown", "text/html"]) {
      const response = await get(`${path}${query}`, { headers: { accept } });
      responseType(response, accept);
      representationHeaders(response);
      const body = await response.text();
      if (accept === "text/markdown") {
        assertModernMarkdown(body, page);
        expect(
          !body.includes("utm_source") && !body.includes("route-test"),
          "tracking must not leak into Markdown",
        ).toBeTruthy();
      } else {
        assertUntrackedHtml(body, page);
        expect(text(body), `${path}: queries must not change visible page content`).toBe(text(untracked));
        expect(tags(body, "meta"), `${path}: queries must not change metadata`).toStrictEqual(tags(untracked, "meta"));
        expect(tags(body, "link"), `${path}: queries must not change document links`).toStrictEqual(
          tags(untracked, "link"),
        );
      }
    }
  }
});

for (const page of publicPages) {
  test(`${page.path}: locale alias is a permanent query-preserving, cookie-free redirect`, async () => {
    for (const suffix of ["", ".md"]) {
      const target = suffix ? markdownPath(page.path) : page.path;
      const path = suffix ? `/en${target}` : `/en${page.path === "/" ? "" : page.path}`;
      const response = await get(`${path}${query}`);
      expect(response.status, path).toBe(308);
      representationHeaders(response);
      const location = new URL(response.headers.get("location"), Bun.env.DOCS_TEST_URL);
      expect(location.origin).toBe(new URL(Bun.env.DOCS_TEST_URL).origin);
      expect(location.pathname).toBe(target);
      expect(location.search).toBe(query);
      expect(location.hash).toBe("");
      await response.body?.cancel();
    }
  });
}

test("trailing slashes keep permanent public paths and query strings", async () => {
  for (const page of publicPages.filter((page) => page.path !== "/")) {
    const response = await get(`${page.path}/${query}`);
    expect(response.status, page.path).toBe(308);
    expect(response.headers.get("set-cookie")).toBe(null);
    const location = new URL(response.headers.get("location"), Bun.env.DOCS_TEST_URL);
    expect(location.pathname).toBe(page.path);
    expect(location.search).toBe(query);
    await response.body?.cancel();
  }
});

for (const path of [
  "/missing-page",
  "/docs",
  "/docs/commands",
  "/fr/commands",
  "/providers/missing",
  "/engines/missing",
]) {
  for (const [name, url, headers, type] of [
    ["HTML", path, {}, "text/html"],
    ["explicit Markdown", `${path}.md`, {}, "text/markdown"],
    ["negotiated Markdown", path, { accept: "text/markdown" }, "text/markdown"],
    ["API Markdown", `/api/docs-md${path}`, {}, "text/markdown"],
  ]) {
    test(`404 ${name}: ${url}`, async () => {
      const response = await get(url, { headers });
      responseType(response, type, 404);
      representationHeaders(response);
      const body = await response.text();
      indexing(response, type === "text/html" ? body : undefined, true);
      if (type === "text/markdown") {
        expect(body).toMatch(/not found/i);
        expect(body.includes("/sitemap.md") && body.includes("/llms.txt")).toBeTruthy();
      } else expect(text(body)).toMatch(/not found/i);
      const head = await get(url, { method: "HEAD", headers });
      responseType(head, type, 404);
      representationHeaders(head);
      indexing(head, undefined, true);
      expect(await head.text()).toBe("");
    });
  }
}

for (const path of [
  "/%",
  "/%25",
  "/%2F",
  "/%5C",
  "/commands%2Fmissing",
  "/%252F",
  "/%E0%A4%A",
  "/%C0%AF",
  "/%00",
  "/%7F",
]) {
  for (const [name, url, headers] of [
    ["HTML", path, {}],
    ["explicit Markdown", `${path}.md`, {}],
    ["negotiated Markdown", path, { accept: "text/markdown" }],
    ["API Markdown", `/api/docs-md${path}`, {}],
  ]) {
    test(`malformed path is a real 404, never a decoding 500: ${name} ${url}`, async () => {
      const response = await rawGet(url, headers);
      expect(response.status, url).toBe(404);
      representationHeaders(response);
      indexing(response, undefined, true);
      expect(!response.headers.has("location")).toBeTruthy();
      const body = await response.text();
      expect(!/URIError|Internal Server Error/.test(body)).toBeTruthy();
    });
  }
}

test("legacy Markdown handles required, missing, unknown and normalized path parameters", async () => {
  for (const path of ["/api/docs-markdown", "/api/docs-markdown?path="]) {
    const response = await get(path);
    responseType(response, "application/json", 400);
    expect(await response.json()).toStrictEqual({
      error: "Missing ?path= parameter",
    });
  }
  for (const path of ["/not-a-page", "/commands.md", "/fr/commands"]) {
    const response = await get(legacyPath(path));
    responseType(response, "application/json", 404);
    expect(await response.json()).toStrictEqual({ error: "Page not found" });
  }
  for (const path of ["commands", "/commands/", "providers/browserbase", "/providers/browserbase/"]) {
    const response = await get(legacyPath(path));
    responseType(response, "text/markdown");
    const canonicalPath = `/${path.replace(/^\//, "").replace(/\/$/, "")}`;
    assertLegacyMarkdown(await response.text(), pageAt(canonicalPath));
  }
  const duplicate = await get("/api/docs-markdown?path=%2Fcommands&path=%2Fmissing");
  responseType(duplicate, "text/markdown");
  // First path parameter wins, matching original URLSearchParams.get.
  assertLegacyMarkdown(await duplicate.text(), pageAt("/commands"));
});

test("legacy Markdown never resolves traversal or malformed path values to unrelated pages", async () => {
  for (const path of [
    "/../commands",
    "/commands/../../package",
    "/commands\\missing",
    "/commands\u0000",
    "/%2f",
    "/%",
    "/%E0%A4%A",
  ]) {
    const response = await get(legacyPath(path));
    expect(
      [400, 404].includes(response.status),
      `${path}: must reject unsafe input, got ${response.status}`,
    ).toBeTruthy();
    expect(response.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    const body = await response.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length > 0).toBeTruthy();
  }
});

test("WebMCP search results use Features without changing the public URL", async () => {
  const legacy = await get("/api/search?q=webmcp");
  responseType(legacy, "application/json");
  const { results } = await legacy.json();
  const matches = results.filter((result) => result.href === "/webmcp");
  expect(matches.length).toBe(1);
  expect(matches[0].section).toBe("Features");
  const native = await get("/api/search?query=webmcp&locale=en");
  responseType(native, "application/json");
  const nativeMatches = (await native.json()).filter((result) => result.type === "page" && result.url === "/webmcp");
  expect(nativeMatches.length).toBe(1);
  expect(nativeMatches[0].breadcrumbs.includes("Features")).toBeTruthy();
  expect(!nativeMatches[0].breadcrumbs.includes("Reference")).toBeTruthy();
});

for (const page of fixturePages.filter(
  (page) => ["Providers", "Engines"].includes(page.navigation.section) || page.path === "/changelog",
)) {
  test(`native search preserves original section breadcrumbs for ${page.path}`, async () => {
    const response = await get(`/api/search?query=${encodeURIComponent(page.navigation.title)}&locale=en`);
    responseType(response, "application/json");
    const matches = (await response.json()).filter((result) => result.type === "page" && result.url === page.path);
    expect(matches.length).toBe(1);
    expect(matches[0].breadcrumbs).toStrictEqual(["Docs", page.navigation.section].filter(Boolean));
  });
}

for (const probe of [
  {
    query: "restoreCheckFn",
    path: "/configuration",
    fragment: "all-options",
    text: "restoreCheckFn",
    kind: "HTML table code cell",
  },
  {
    query: "libx264",
    path: "/recording",
    fragment: "requirements",
    text: "libx264",
    kind: "nested inline code in prose",
  },
  {
    query: "unintended visual changes",
    path: "/diffing",
    fragment: "visual-regression-testing",
    text: "unintended visual changes",
    kind: "nested H3 section",
  },
]) {
  test(`native search indexes ${probe.kind} with addressable content fragments`, async () => {
    const page = pageAt(probe.path);
    expect(page.modernMarkdown.includes(probe.text), "query evidence must exist in original source").toBeTruthy();
    expect(
      page.headings.some((heading) => heading.id === probe.fragment),
      "fragment must come from the original slugger",
    ).toBeTruthy();
    const response = await get(`/api/search?query=${encodeURIComponent(probe.query)}&locale=en`);
    responseType(response, "application/json");
    const results = await response.json();
    expect(Array.isArray(results), "native query= contract is a Fumadocs result array").toBeTruthy();
    expect(
      results.some(
        (result) =>
          result.type === "text" &&
          result.url === `${probe.path}#${probe.fragment}` &&
          result.content.includes(probe.text),
      ),
      JSON.stringify(results),
    ).toBeTruthy();
    for (const result of results) {
      expect(typeof result.id).toBe("string");
      expect(typeof result.content).toBe("string");
      expect(["page", "heading", "text"].includes(result.type)).toBeTruthy();
      const target = new URL(result.url, origin);
      expect(target.origin).toBe(origin);
      const destination = pageAt(target.pathname);
      expect(destination, `search leaked non-public route ${result.url}`).toBeTruthy();
      if (target.hash) {
        const html = await htmlFor(destination);
        expect(
          [...html.matchAll(/\sid="([^"]*)"/g)].some(
            (match) => decode(match[1]) === decodeURIComponent(target.hash.slice(1)),
          ),
          `search returned missing fragment ${result.url}`,
        ).toBeTruthy();
      }
    }
  });
}

test("native search empty and unmatched queries return arrays, not legacy objects", async () => {
  for (const query of ["", "zzzyyy-nonexistent-123456"]) {
    const response = await get(`/api/search?query=${encodeURIComponent(query)}&locale=en`);
    responseType(response, "application/json");
    expect(await response.json()).toStrictEqual([]);
  }
});

test("Modern Web Guidance page renders its workflows, metadata and Markdown representations", async () => {
  const path = "/modern-web-guidance";
  const response = await get(path);
  responseType(response, "text/html");
  representationHeaders(response);
  const html = await response.text();
  indexing(response, html);
  expect([...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((match) => text(match[1]))).toStrictEqual([
    "Modern Web Guidance | agent-browser",
  ]);
  expect(meta(html, "og:url")).toStrictEqual([canonical(path)]);
  expect(
    tags(html, "link")
      .filter((tag) => tag.rel === "canonical")
      .map((tag) => tag.href),
  ).toStrictEqual([canonical(path)]);
  expect(
    tags(html, "link")
      .filter((tag) => tag.rel === "alternate" && tag.type === "text/markdown")
      .map((tag) => tag.href),
  ).toStrictEqual([`${origin}${markdownPath(path)}`]);
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  expect(main, "content must be in main, not only Flight scripts").toBeTruthy();
  const visible = text(main);
  for (const sample of [
    "Verify a layout-shift fix",
    "Check a dialog transition with reduced motion",
    "Check focus and inert behavior of a dialog",
    "agent-browser vitals",
    "prefers-reduced-motion",
  ])
    expect(visible.includes(normalize(sample)), `SSR lost ${sample}`).toBeTruthy();
  const internalLinks = new Set(
    tags(main, "a")
      .map((tag) => tag.href)
      .filter((href) => typeof href === "string" && href.startsWith("/")),
  );
  for (const href of ["/react", "/snapshots", "/recording", "/debugging"])
    expect(internalLinks.has(href), `lost related link ${href}`).toBeTruthy();
  for (const href of internalLinks) {
    const link = await get(href);
    expect(link.status, href).toBe(200);
  }
  const bodies = [];
  for (const [markdownPathOrRoute, headers] of [
    [apiPath(path), {}],
    [markdownPath(path), {}],
    [path, { accept: "text/markdown" }],
  ]) {
    const body = await get(markdownPathOrRoute, { headers });
    responseType(body, "text/markdown");
    representationHeaders(body);
    bodies.push(await body.text());
  }
  expect(bodies[0]).toBe(bodies[1]);
  expect(bodies[1]).toBe(bodies[2]);
  expect(bodies[1].includes("## Verify a layout-shift fix")).toBeTruthy();
  for (const heading of renderedHeadings(main))
    expect(
      bodies[1].includes(`${"#".repeat(heading.level)} ${heading.text}`),
      `Markdown lost heading ${heading.text}`,
    ).toBeTruthy();
});

test("sitemap contains exactly the 40 canonical production URLs", async () => {
  const response = await get("/sitemap.xml", { headers: agent });
  responseType(response, "application/xml");
  indexing(response);
  const xml = await response.text();
  expect(xml).toMatch(/<urlset\b/);
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => decode(match[1]));
  expect(locations.sort()).toStrictEqual(publicPages.map((page) => canonical(page.path)).sort());
  expect(!xml.includes("/en/") && !xml.includes("localhost") && !xml.includes("127.0.0.1")).toBeTruthy();
});

for (const path of ["/llms.txt", "/sitemap.md"]) {
  test(`${path}: agent index exposes all 40 public pages and Markdown alternatives exactly once`, async () => {
    const response = await get(path, { headers: agent });
    responseType(response, path.endsWith(".md") ? "text/markdown" : "text/plain");
    indexing(response);
    const body = await response.text();
    const links = [...body.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)/gm)].map((match) => [match[1], match[2]]);
    expect(links.sort((a, b) => a[1].localeCompare(b[1]))).toStrictEqual(
      publicPages.map((page) => [page.markdownTitle, canonical(page.path)]).sort((a, b) => a[1].localeCompare(b[1])),
    );
    const markdownLinks = [...body.matchAll(/\[Markdown\]\(([^)]+)\)/g)].map((match) => match[1]);
    expect(markdownLinks.sort()).toStrictEqual(publicPages.map((page) => `${origin}${markdownPath(page.path)}`).sort());
    expect(!body.includes("/en/") && !body.includes("localhost") && !body.includes("127.0.0.1")).toBeTruthy();
    const head = await get(path, { method: "HEAD", headers: agent });
    responseType(head, path.endsWith(".md") ? "text/markdown" : "text/plain");
    indexing(head);
    expect(await head.text()).toBe("");
  });
}

test("robots is environment-aware without losing the production sitemap", async () => {
  const response = await get("/robots.txt", { headers: agent });
  responseType(response, "text/plain");
  indexing(response);
  const directives = (await response.text())
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  expect(directives.includes("user-agent: *")).toBeTruthy();
  expect(directives.includes(`sitemap: ${origin}/sitemap.xml`)).toBeTruthy();
  expect(directives.includes(noindex ? "disallow: /" : "allow: /")).toBeTruthy();
  if (!noindex) expect(!directives.some((line) => /^disallow:\s*\S/.test(line))).toBeTruthy();
});

for (const resource of currentResources) {
  test(`${resource.path}: original static resource bytes bypass locale and Markdown routing`, async () => {
    const response = await get(resource.path, { headers: agent });
    expect(response.status).toBe(200);
    indexing(response);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBe(resource.size);
    expect(hash(bytes), resource.source).toBe(resource.sha256);
    expect(response.headers.get("content-type") ?? "").not.toMatch(/text\/(html|markdown)/);
    if (resource.path.endsWith(".png")) expect(response.headers.get("content-type")?.split(";")[0]).toBe("image/png");
    if (resource.path.endsWith(".json"))
      expect(response.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    const head = await get(resource.path, { method: "HEAD", headers: agent });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
}

for (const page of publicPages) {
  test(`${page.path}: original OG endpoint returns an actual 1200x630 PNG for agents`, async () => {
    const response = await get(`/og${page.path === "/" ? "" : page.path}`, {
      headers: agent,
    });
    responseType(response, "image/png");
    indexing(response);
    const png = Buffer.from(await response.arrayBuffer());
    expect([...png.subarray(0, 8)]).toStrictEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });
}

test("unknown OG routes retain the original JSON 404", async () => {
  const response = await get("/og/missing-page", { headers: agent });
  responseType(response, "application/json", 404);
  expect(await response.json()).toStrictEqual({ error: "Not found" });
});

test("Next static CSS, JavaScript and fonts remain binary/static resources for agents", async () => {
  const response = await get("/");
  responseType(response, "text/html");
  const html = await response.text();
  const css = tags(html, "link").find((tag) => tag.rel === "stylesheet" && tag.href.startsWith("/_next/"))?.href;
  const js = tags(html, "script").find((tag) => tag.src?.startsWith("/_next/"))?.src;
  const font =
    tags(html, "link").find((tag) => tag.as === "font" && tag.href.startsWith("/_next/"))?.href ??
    /<([^>]+\.woff2)>/.exec(response.headers.get("link") ?? "")?.[1];
  for (const [url, type] of [
    [css, /^text\/css/],
    [js, /^(application|text)\/javascript/],
    [font, /^(font\/|application\/(font|octet-stream))/],
  ]) {
    expect(url?.startsWith("/_next/"), "SSR must advertise a bundled resource").toBeTruthy();
    const resource = await get(url, { headers: agent });
    expect(resource.status).toBe(200);
    expect(resource.headers.get("content-type") ?? "").toMatch(type);
    expect((await resource.arrayBuffer()).byteLength > 0).toBeTruthy();
    expect(resource.headers.get("set-cookie")).toBe(null);
  }
});
