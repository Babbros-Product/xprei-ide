// Minimal, dependency-free HTML-to-text conversion for the @url context
// provider. Not a real HTML parser — a hand-rolled regex pass, good
// enough for "readable page text for the model," not robust against
// every malformed-HTML edge case a real parser would handle. Dropping
// <script>/<style> content entirely (not just their tags) is the main
// thing that matters: without it, a page's JS/CSS would flood the
// context with noise.

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
