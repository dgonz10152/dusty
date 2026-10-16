// Models often write LaTeX as \( \) and \[ \]. remark-math only parses $ and $$, and Markdown treats
// "\(" as an escaped "(", so those formulas would show as raw text. Code spans and fences are left alone.
export function normalizeMath(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m.trim()}$`),
    )
    .join("");
}

type Node = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: Node[] };

// Browsers may break a line after KaTeX's inline-blocks, stranding the "." in "$q \neq 0$.".
// This rehype plugin (run after rehype-katex) glues trailing punctuation to its formula.
export function rehypeMathPunctuation() {
  const isKatex = (n: Node) => Array.isArray(n.properties?.className) && n.properties.className.includes("katex");
  const walk = (node: Node) => {
    if (!node.children) return;
    const out: Node[] = [];
    node.children.forEach((child, i) => {
      const next = node.children![i + 1];
      const punct = next?.type === "text" ? /^[.,;:!?)]+/.exec(next.value ?? "")?.[0] : undefined;
      if (child.type === "element" && isKatex(child) && punct) {
        next.value = next.value!.slice(punct.length);
        out.push({
          type: "element",
          tagName: "span",
          properties: { className: ["math-nowrap"] },
          children: [child, { type: "text", value: punct }],
        });
      } else {
        walk(child);
        out.push(child);
      }
    });
    node.children = out;
  };
  return walk;
}
