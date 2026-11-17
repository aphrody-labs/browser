import { expect, test } from "bun:test";
import { evaluate } from "@mdx-js/mdx";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as runtime from "react/jsx-runtime";
import { evaluateOriginal } from "../scripts/original-modules.ts";
import { baseline, pages, normalize, text, renderedHeadings } from "./helpers.ts";

const evaluated = await evaluateOriginal<{ useMDXComponents: (components: object) => Record<string, unknown> }>(
  baseline.sources["docs/mdx-components.tsx"].raw,
  "original-mdx-components.tsx",
  {
    "react/jsx-runtime": runtime,
    "react/jsx-dev-runtime": await import("react/jsx-dev-runtime"),
    "next/link": {
      __esModule: true,
      default: (props) => React.createElement("a", props),
    },
    "@/components/code-block": {
      CodeBlock: ({ code }) => React.createElement("pre", null, code),
    },
  },
);
const components = {
  ...evaluated.useMDXComponents({}),
  pre: (props) => React.createElement("pre", props),
  DiffDemo: () => null,
};

test("actual original React heading components recurse through nested inline children without deduplicating", () => {
  const children = [
    "Nested ",
    React.createElement("strong", { key: "bold" }, ["bold ", React.createElement("code", { key: "code" }, "--Flag")]),
    " & ",
    React.createElement("a", { key: "link", href: "/" }, "Link"),
    " ",
    42,
  ];
  const html = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(components.h2, null, children),
      React.createElement(components.h2, null, children),
    ),
  );
  expect(renderedHeadings(html)).toStrictEqual([
    {
      level: 2,
      text: "Nested bold --Flag & Link 42",
      id: "nested-bold---flag-link-42",
    },
    {
      level: 2,
      text: "Nested bold --Flag & Link 42",
      id: "nested-bold---flag-link-42",
    },
  ]);
});

for (const page of pages) {
  test(`${page.path}: captured content and anchors agree with independently rendered original MDX`, async () => {
    const raw = baseline.sources[page.source].raw.replace(
      /^import \{ DiffDemo \} from "@\/components\/diff-demo"\r?\n/,
      "",
    );
    const { default: Content } = await evaluate(raw, { ...runtime });
    const html = renderToStaticMarkup(React.createElement(Content, { components }));
    expect(renderedHeadings(html)).toStrictEqual(page.headings);
    const visible = text(html);
    for (const sample of page.content)
      expect(
        visible.includes(normalize(sample)),
        `${page.path}: invalid SSR oracle sample ${JSON.stringify(sample)}`,
      ).toBeTruthy();
  });
}
