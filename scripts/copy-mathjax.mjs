// Copy the parts of MathJax 4 the app uses into public/vendor so math renders
// offline (MathJax would otherwise fetch fonts from a CDN). Runs before
// `npm run dev` and `npm run build`.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "public", "vendor");

const copies = [
  // TeX input + SVG output (font included), and the TeX extensions loaded on demand.
  ["mathjax/tex-svg.js", "mathjax/tex-svg.js"],
  ["mathjax/input/tex/extensions", "mathjax/input/tex/extensions"],
  // New Computer Modern glyphs beyond the built-in set, loaded on demand.
  ["@mathjax/mathjax-newcm-font/svg", "@mathjax/mathjax-newcm-font/svg"],
  ["@mathjax/mathjax-newcm-font/svg.js", "@mathjax/mathjax-newcm-font/svg.js"],
  ["@mathjax/mathjax-newcm-font/package.json", "@mathjax/mathjax-newcm-font/package.json"],
];

rmSync(out, { recursive: true, force: true });
for (const [from, to] of copies) {
  const src = join(nm, from);
  if (!existsSync(src)) {
    console.error(`copy-mathjax: missing ${src} (run npm install)`);
    process.exit(1);
  }
  mkdirSync(dirname(join(out, to)), { recursive: true });
  cpSync(src, join(out, to), { recursive: true });
}
console.log("copy-mathjax: MathJax 4 copied to public/vendor");
