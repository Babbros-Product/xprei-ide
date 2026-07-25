import assert from "node:assert/strict";
import { test } from "node:test";
import { stripHtml } from "./htmlStrip";

test("stripHtml removes tags and collapses whitespace", () => {
  const out = stripHtml("<html><body><p>Hello   world</p></body></html>");
  assert.equal(out, "Hello world");
});

test("stripHtml drops <script> blocks entirely, including their content", () => {
  const out = stripHtml("<p>before</p><script>alert('x')</script><p>after</p>");
  assert.equal(out, "before after");
});

test("stripHtml drops <style> blocks entirely, including their content", () => {
  const out = stripHtml("<p>before</p><style>.x { color: red; }</style><p>after</p>");
  assert.equal(out, "before after");
});

test("stripHtml drops HTML comments", () => {
  const out = stripHtml("<p>before</p><!-- a comment --><p>after</p>");
  assert.equal(out, "before after");
});

test("stripHtml decodes common HTML entities", () => {
  const out = stripHtml("<p>Tom &amp; Jerry &lt;3 &quot;friends&quot;&nbsp;forever</p>");
  assert.equal(out, 'Tom & Jerry <3 "friends" forever');
});

test("stripHtml returns an empty string for empty input", () => {
  assert.equal(stripHtml(""), "");
});
