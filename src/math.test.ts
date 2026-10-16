import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMath, rehypeMathPunctuation } from "./math.ts";

test("normalizeMath", () => {
  assert.equal(normalizeMath(String.raw`why is \(\frac{p}{q}\) in lowest terms`), String.raw`why is $\frac{p}{q}$ in lowest terms`);
  assert.equal(normalizeMath(String.raw`see \[ x^2 \] here`), "see \n$$\nx^2\n$$\n here");
  assert.equal(normalizeMath(String.raw`already $\sqrt{2}$`), String.raw`already $\sqrt{2}$`);
  // verbatim from a real quiz tool call
  assert.equal(
    normalizeMath(String.raw`In the proof that \(\sqrt{2}\) is irrational, why is it crucial to assume that the fraction \(\frac{p}{q}\) is in lowest terms?`),
    String.raw`In the proof that $\sqrt{2}$ is irrational, why is it crucial to assume that the fraction $\frac{p}{q}$ is in lowest terms?`,
  );
  assert.equal(normalizeMath(String.raw`\(p\) and \(q\) are integers and \(q \neq 0\)`), String.raw`$p$ and $q$ are integers and $q \neq 0$`);
  // code is untouched
  const code = "```latex\n\\(x\\)\n```";
  assert.equal(normalizeMath(code), code);
  assert.equal(normalizeMath("`\\(x\\)` and \\(y\\)"), "`\\(x\\)` and $y$");
});

test("rehypeMathPunctuation", () => {
  const katex = { type: "element", tagName: "span", properties: { className: ["katex"] }, children: [] };
  const tree = { type: "root", children: [{ type: "element", tagName: "p", properties: {}, children: [katex, { type: "text", value: ". Next" }] }] };
  rehypeMathPunctuation()(tree);
  const p = tree.children[0].children as { type: string; value?: string; properties?: { className?: string[] } }[];
  assert.deepEqual(p[0].properties?.className, ["math-nowrap"]);
  assert.equal(p[1].value, " Next");
});
