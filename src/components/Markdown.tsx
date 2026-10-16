import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openUrl } from "@tauri-apps/plugin-opener";
import "katex/dist/katex.min.css";
import { normalizeMath, rehypeMathPunctuation } from "../math";
import { layers, parseDeps } from "../graph";

// Loaded on first diagram; mermaid is the heaviest dependency by far.
async function renderMermaid(id: string, code: string) {
  const { default: mermaid } = await import("mermaid");
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    look: "classic",
    themeVariables: {
      useGradient: false,
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

const ICONS = new Set<string>(iconNames);

// Edges drop from the source to their bus, run across, and drop onto the target's top.
function elbow(x1: number, y1: number, x2: number, y2: number, bus: number) {
  const dx = x2 - x1;
  if (Math.abs(dx) < 1) return `M${x1} ${y1}V${y2}`;
  const r = Math.min(8, Math.abs(dx) / 2);
  const s = Math.sign(dx);
  return `M${x1} ${y1}V${bus - r}Q${x1} ${bus} ${x1 + s * r} ${bus}H${x2 - s * r}Q${x2} ${bus} ${x2} ${bus + r}V${y2}`;
}

type DrawnEdge = { from: string; to: string; d: string };

function DepGraph({ code }: { code: string }) {
  const graph = useMemo(() => {
    try {
      return layers(parseDeps(code));
    } catch {
      return null;
    }
  }, [code]);
  const [open, setOpen] = useState<string | null>(null);
  const [edges, setEdges] = useState<DrawnEdge[]>([]);
  const canvas = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = canvas.current;
    if (!root || !graph) return;
    const rowOf = new Map(graph.rows.flatMap((row, i) => row.map((n) => [n.id, i] as const)));
    const vias = new Set(graph.rows.flat().filter((n) => n.via).map((n) => n.id));
    const measure = () => {
      const base = root.getBoundingClientRect();
      const box = (id: string) => root.querySelector(`[data-id="${CSS.escape(id)}"]`)!.getBoundingClientRect();
      const rows = [...root.querySelectorAll(".dep-row")].map((el) => el.getBoundingClientRect());
      const midX = (id: string) => {
        const r = box(id);
        return r.left - base.left + r.width / 2;
      };
      // A source that forks gets its own bus; edges from single-target sources share their target's merge bus.
      // Each bus in a gap sits at its own height, so unrelated horizontals never line up.
      const segments = graph.edges.flatMap(({ chain }) => chain.slice(1).map((to, i) => [chain[i], to] as const));
      const targets = new Map<string, Set<string>>();
      for (const [from, to] of segments) targets.set(from, (targets.get(from) ?? new Set()).add(to));
      const busKey = (from: string, to: string) => (targets.get(from)!.size > 1 ? from : to);
      const keysByGap = new Map<number, Set<string>>();
      for (const [from, to] of segments) {
        const gap = rowOf.get(from)!;
        keysByGap.set(gap, (keysByGap.get(gap) ?? new Set()).add(busKey(from, to)));
      }
      const bus = (from: string, to: string) => {
        const gap = rowOf.get(from)!;
        const keys = [...keysByGap.get(gap)!].sort((a, b) => midX(a) - midX(b));
        const top = rows[gap].bottom - base.top;
        return top + ((keys.indexOf(busKey(from, to)) + 1) * (rows[gap + 1].top - rows[gap].bottom)) / (keys.length + 1);
      };
      setEdges(
        graph.edges.map(({ from, to, chain }) => ({
          from,
          to,
          d: chain
            .slice(1)
            .map((id, i) => {
              // A via slot spans its whole row, so the edge leaves from its top to pass straight through.
              const start = box(chain[i]);
              const y1 = (vias.has(chain[i]) ? start.top : start.bottom) - base.top;
              return elbow(midX(chain[i]), y1, midX(id), box(id).top - base.top, bus(chain[i], id));
            })
            .join(""),
        })),
      );
    };
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    root.querySelectorAll("[data-id]").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [graph]);

  if (!graph) return <CodeBlock code={code} lang="deps" />;
  const lit = (e: DrawnEdge) => e.from === open || e.to === open;
  return (
    <div className="visual dep-graph">
      <div className="dep-canvas" ref={canvas}>
        <svg className="dep-edges" aria-hidden>
          {[...edges.filter((e) => !lit(e)), ...edges.filter(lit)].map((e) => (
            <path key={`${e.from}>${e.to}`} d={e.d} className={lit(e) ? "lit" : undefined} />
          ))}
        </svg>
        {graph.rows.map((row, i) => (
          <div className="dep-row" key={i}>
            {row.map((n) => {
              if (n.via) return <div key={n.id} data-id={n.id} className="dep-via" />;
              const isOpen = open === n.id;
              const Chevron = isOpen ? ChevronDown : ChevronRight;
              return (
                <div key={n.id} data-id={n.id} className={`dep-card${isOpen ? " open" : ""}`}>
                  <button className="dep-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : n.id)}>
                    <DynamicIcon name={(ICONS.has(n.icon) ? n.icon : "circle-dot") as IconName} size={16} className="dep-icon" />
                    <span className="dep-label">{n.label}</span>
                    <Chevron size={14} className="dep-chevron" />
                  </button>
                  {isOpen && n.summary && (
                    <div className="dep-summary">
                      <div className="dep-kind">Summary</div>
                      <Markdown text={n.summary} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
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
      if (lang === "deps" && !streaming) return <DepGraph code={code} />;
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
