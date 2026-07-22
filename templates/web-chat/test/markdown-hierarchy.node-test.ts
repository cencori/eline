import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMarkdownHierarchy } from "../lib/markdown-hierarchy.ts";

test("promotes a leading standalone bold line and keeps only three levels", () => {
  const markdown = [
    "**Using Arcie – Quick-Start Guide**",
    "",
    "Introductory copy.",
    "",
    "### 1. Install the package",
    "",
    "#### Helpful links",
    "",
    "###### API reference",
  ].join("\n");

  assert.equal(
    normalizeMarkdownHierarchy(markdown),
    [
      "# Using Arcie – Quick-Start Guide",
      "",
      "Introductory copy.",
      "",
      "## 1. Install the package",
      "",
      "### Helpful links",
      "",
      "### API reference",
    ].join("\n"),
  );
});

test("preserves an existing title and compresses deeper headings", () => {
  const markdown = "# Title\n\n## Section\n\n##### Detail";
  assert.equal(normalizeMarkdownHierarchy(markdown), "# Title\n\n## Section\n\n### Detail");
});

test("uses the shallowest heading as a section when there is no title", () => {
  const markdown = "### First section\n\n##### Supporting detail";
  assert.equal(
    normalizeMarkdownHierarchy(markdown),
    "## First section\n\n### Supporting detail",
  );
});

test("does not rewrite heading-like content inside fenced code", () => {
  const markdown = [
    "**Example**",
    "",
    "```md",
    "#### Keep this literal",
    "```",
    "",
    "#### Render this heading",
  ].join("\n");

  assert.equal(
    normalizeMarkdownHierarchy(markdown),
    [
      "# Example",
      "",
      "```md",
      "#### Keep this literal",
      "```",
      "",
      "## Render this heading",
    ].join("\n"),
  );
});
