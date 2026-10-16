// Course material for exam sessions: what the student uploads, turned into text the tutor reads.

export type Material = { name: string; content: string };

// ponytail: the whole material rides along in every exam and child turn, so it has to fit the context window
// (~75k tokens here). Retrieval over chunks is the upgrade path if real courses blow past this.
export const MAX_MATERIAL_CHARS = 300_000;

/** Why this material can't be used, or null when it's fine. */
export function materialError(items: Material[]): string | null {
  const total = items.reduce((n, m) => n + m.content.length, 0);
  if (total <= MAX_MATERIAL_CHARS) return null;
  const pct = Math.round((total / MAX_MATERIAL_CHARS) * 100);
  return `That's too much material (${pct}% of the limit). Remove a file or trim it to what the exam covers.`;
}

/** The message that hands the tutor the material. It goes first in the conversation and is never stored. */
export function materialMessage(items: Material[]): string {
  const files = items.map((m) => `# file: ${m.name}\n\n${m.content.trim()}`).join("\n\n");
  return `Here is my course material for the exam. Treat it as the source of truth for what's in scope, and for its notation and definitions.\n\n<course_material>\n${files}\n</course_material>`;
}

export async function extractText(file: File): Promise<string> {
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return file.text();
  // Loaded on first PDF, like mermaid.
  const [{ getDocument, GlobalWorkerOptions }, { default: workerSrc }] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = workerSrc;
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const { items } = await (await pdf.getPage(i)).getTextContent();
      const text = items.map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : "")).join("");
      pages.push(`--- Page ${i} ---\n${text.trim()}`);
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}
