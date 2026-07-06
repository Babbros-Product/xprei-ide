// Deep-merge build/product.branding.json into a cloned Code-OSS product.json.
// Only the keys we override are touched; every upstream field is preserved. This
// keeps the fork diff to a single generated file instead of a hand-maintained one.
//
//   node build/scripts/patch-product.mjs <path-to-vscode-checkout>

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // repo root
const vscodeDir = process.argv[2];
if (!vscodeDir) {
  console.error("usage: node patch-product.mjs <vscode-checkout>");
  process.exit(1);
}

const branding = JSON.parse(readFileSync(join(root, "build", "product.branding.json"), "utf8"));
const productPath = join(vscodeDir, "product.json");
const product = JSON.parse(readFileSync(productPath, "utf8"));

// Shallow-merge is enough: our overrides are all top-level keys (including the
// whole extensionsGallery object, which we replace wholesale to point at Open VSX).
Object.assign(product, branding);

writeFileSync(productPath, JSON.stringify(product, null, "\t") + "\n");
console.log(`Patched ${productPath} with xpreiIDE branding + Open VSX gallery.`);
