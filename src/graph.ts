// The ```deps block: the lesson's dependency map, rendered by DepGraph in Markdown.tsx.

export type DepNode = { id: string; label: string; icon: string; summary: string; needs: string[] };

export function parseDeps(code: string): DepNode[] {
  const raw = JSON.parse(code)?.nodes;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("deps: no nodes");
  const nodes: DepNode[] = raw.map((n) => ({
    id: String(n.id),
    label: String(n.label ?? n.id),
    icon: String(n.icon ?? ""),
    summary: String(n.summary ?? ""),
    needs: Array.isArray(n.needs) ? n.needs.map(String) : [],
  }));
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) throw new Error("deps: duplicate id");
  for (const n of nodes) for (const d of n.needs) if (!ids.has(d)) throw new Error(`deps: unknown id ${d}`);
  ranks(nodes); // throws on a cycle
  return nodes;
}

export type Slot = DepNode & { via?: true };
export type Edge = { from: string; to: string; chain: string[] };

// Rows for drawing top-down: each node sits just above the first node that needs it,
// an edge that skips rows gets an invisible `via` slot in each so it has its own lane,
// and each row is ordered under its dependencies to keep edges from crossing.
export function layers(nodes: DepNode[]): { rows: Slot[][]; edges: Edge[] } {
  const rank = ranks(nodes);
  const byRankDesc = [...nodes].sort((a, b) => rank.get(b.id)! - rank.get(a.id)!);
  for (const n of byRankDesc) {
    const users = nodes.filter((m) => m.needs.includes(n.id)).map((m) => rank.get(m.id)!);
    if (users.length) rank.set(n.id, Math.min(...users) - 1);
  }

  const slots = new Map<string, Slot>(nodes.map((n) => [n.id, { ...n, needs: [...n.needs] }]));
  const edges: Edge[] = [];
  for (const n of nodes) {
    for (const from of n.needs) {
      const chain = [from];
      for (let r = rank.get(from)! + 1; r < rank.get(n.id)!; r++) {
        const id = `${from}>${n.id}@${r}`;
        slots.set(id, { id, label: "", icon: "", summary: "", needs: [chain.at(-1)!], via: true });
        rank.set(id, r);
        chain.push(id);
      }
      const target = slots.get(n.id)!;
      target.needs = target.needs.map((d) => (d === from ? chain.at(-1)! : d));
      edges.push({ from, to: n.id, chain: [...chain, n.id] });
    }
  }

  const rows: Slot[][] = [];
  for (const n of slots.values()) (rows[rank.get(n.id)!] ??= []).push(n);
  const dense = rows.filter(Boolean);
  const col = new Map<string, number>();
  for (const row of dense) {
    const center = (n: Slot) => (n.needs.length ? n.needs.reduce((t, d) => t + col.get(d)!, 0) / n.needs.length : Infinity);
    if (row !== dense[0]) row.sort((a, b) => center(a) - center(b));
    row.forEach((n, i) => col.set(n.id, i - (row.length - 1) / 2));
  }
  return { rows: dense, edges };
}

// Row of each node = length of its longest chain of dependencies, so roots sit at 0.
export function ranks(nodes: DepNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error("deps: cycle");
    visiting.add(id);
    const r = Math.max(-1, ...byId.get(id)!.needs.map(visit)) + 1;
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  nodes.forEach((n) => visit(n.id));
  return rank;
}
