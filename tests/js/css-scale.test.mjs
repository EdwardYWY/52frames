// The stylesheet's sizes come from the scale in :root (--fs-*, --sp-*, --lh-*, --ls-*), so spacing
// and type stay consistent. This fails on a raw value in the properties the scale covers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../site/css/style.css", import.meta.url), "utf8");
// The seat map keeps its own dense sizes: checking stops at its "scale: exempt" note.
const checked = css.slice(0, css.indexOf("scale: exempt")).replace(/\/\*[\s\S]*?\*\//g, "");

/** [line, property, value] for every declaration outside :root's token definitions. */
function declarations() {
  const out = [];
  let offset = 0;
  for (const line of checked.split("\n")) {
    for (const [, prop, value] of line.matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+)/g)) {
      if (!prop.startsWith("-")) out.push([checked.slice(0, offset).split("\n").length, prop, value.trim()]);
    }
    offset += line.length + 1;
  }
  return out;
}

const SPACING = /^(gap|row-gap|column-gap|padding(-\w+)?|margin(-\w+)?)$/;
// 1-3px nudges (hairlines, optical alignment) are below the scale's smallest step.
const rawPx = (value) => (value.match(/-?\d*\.?\d+px/g) || []).filter((v) => !/^-?[123]px$/.test(v));

test("font sizes, line heights and letter spacing come from the type scale", () => {
  const bad = [];
  for (const [line, prop, value] of declarations()) {
    if (prop === "font-size" && !/^var\(--fs-/.test(value)) bad.push(`${line}: ${prop}: ${value}`);
    if (prop === "font" && value !== "inherit") {
      const size = value.match(/(?:^|\s)(var\(--fs-[\w-]+\)|\S*\d\S*)(?:\/(\S+))?\s+var\(--f-/);
      if (!size || !size[1].startsWith("var(--fs-") || (size[2] && !size[2].startsWith("var(--lh-"))) bad.push(`${line}: ${prop}: ${value}`);
    }
    if (prop === "line-height" && !/^var\(--lh-/.test(value)) bad.push(`${line}: ${prop}: ${value}`);
    if (prop === "letter-spacing" && !/^(0|var\(--ls-[\w-]+\))$/.test(value)) bad.push(`${line}: ${prop}: ${value}`);
  }
  assert.deepEqual(bad, [], "use --fs-*, --lh-* and --ls-* from :root");
});

test("gaps, padding and margins come from the spacing scale", () => {
  const bad = declarations()
    .filter(([, prop, value]) => SPACING.test(prop) && rawPx(value).length)
    .map(([line, prop, value]) => `${line}: ${prop}: ${value}`);
  assert.deepEqual(bad, [], "use --sp-* (or --pad-panel, --gap-section, --gap-poster) from :root");
});
