import { memo, useEffect, useId, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openUrl } from "@tauri-apps/plugin-opener";
import "katex/dist/katex.min.css";
import { normalizeMath, rehypeMathPunctuation } from "../math";

// Loaded on first diagram; mermaid is the heaviest dependency by far.
async function renderMermaid(id: string, code: string) {
  const { default: mermaid } = await import("mermaid");
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      fontFamily: getComputedStyle(document.documentElement).fontFamily,
      fontSize: "14px",
      background: "transparent",
      primaryColor: dark ? "#2a2a2a" : "#f4f4f5",
      primaryBorderColor: dark ? "#4a4a4a" : "#d4d4d8",
      primaryTextColor: dark ? "#ececec" : "#18181b",
      secondaryColor: dark ? "#262626" : "#fafafa",
      tertiaryColor: dark ? "#222222" : "#ffffff",
      lineColor: dark ? "#7a7a82" : "#8a8a93",
      dropShadow: "none",
    },
  });
  return mermaid.render(id, code);
}

function Mermaid({ code }: { code: string }) {
  const id = "m" + useId().replace(/[^\w-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    renderMermaid(id, code)
      .then((r) => setSvg(r.svg))
      .catch(() => {
        // mermaid leaves its scratch element in <body> when parsing fails
        document.getElementById(`d${id}`)?.remove();
        setFailed(true);
      });
  }, [id, code]);
  if (failed) return <CodeBlock code={code} lang="mermaid" />;
  if (!svg) return <div className="visual visual-loading" />;
  return <div className="visual" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Svg({ code }: { code: string }) {
  // An <img> never runs scripts inside the SVG, so model output is safe to show as-is.
  const doc = code.includes("xmlns") ? code : code.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return (
    <div className="visual">
      <img alt="" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}`} />
    </div>
  );
}

const CodeBlock = ({ code, lang }: { code: string; lang?: string }) => (
  <pre className="code-block" data-lang={lang}>
    <code>{code}</code>
  </pre>
);

function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const components: Components = {
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      const code = String(children).replace(/\n$/, "");
      const lang = /language-(\w+)/.exec(className ?? "")?.[1];
      if (!lang && !code.includes("\n")) return <code className="inline-code">{children}</code>;
      // Partial diagrams don't parse, so visuals render once the message is complete.
      if (lang === "mermaid" && !streaming) return <Mermaid code={code} />;
      if (lang === "svg" && !streaming) return <Svg code={code} />;
      return <CodeBlock code={code} lang={lang} />;
    },
    a: ({ href, children }) => (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href) openUrl(href);
        }}
      >
        {children}
      </a>
    ),
  };
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex, rehypeMathPunctuation]} components={components}>
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
