// Course material: what the student attaches, turned into text the tutor reads.

import type { PDFPageProxy } from "pdfjs-dist";
import type { ImageData } from "./llm";

export type Material = { name: string; content: string };

// ponytail: the whole material rides along in every exam and child turn, so it has to fit the context window
// (~75k tokens here). Retrieval over chunks is the upgrade path if real courses blow past this.
export const MAX_MATERIAL_CHARS = 300_000;

/** Why a session with this many characters of material can't run, or null when it's fine. */
export function materialError(total: number): string | null {
  if (total <= MAX_MATERIAL_CHARS) return null;
  const pct = Math.round((total / MAX_MATERIAL_CHARS) * 100);
  return `That's too much material (${pct}% of the limit). Remove a file or trim it to what the exam covers.`;
}

/** Hands the tutor the material. Built per turn, never stored in the conversation. */
export function materialMessage(items: Material[]): string {
  const files = items.map((m) => `# file: ${m.name}\n\n${m.content.trim()}`).join("\n\n");
  return `Here is my course material. Treat it as the source of truth for what's in scope, and for its notation and definitions.\n\n<course_material>\n${files}\n</course_material>`;
}

/** Puts each file in front of the message it was attached to, as the model sees it. */
export function withMaterial<M extends { id: number; content: string }>(messages: M[], material: (Material & { message_id: number })[]): M[] {
  return messages.map((m) => {
    const files = material.filter((f) => f.message_id === m.id);
    return files.length ? { ...m, content: `${materialMessage(files)}\n\n${m.content}` } : m;
  });
}

export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i.test(name);

// Claude downscales anything with a longer edge past this anyway.
const MAX_EDGE = 1568;

/**
 * Decodes any picture the webview can show (including iPhone HEIC photos) and re-encodes it as a JPEG
 * that every vision model accepts, scaled down so it stays small.
 */
export async function loadImage(file: File): Promise<ImageData> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d")!;
    // Transparent PNGs would turn black as JPEGs.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    return { mime: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  } finally {
    URL.revokeObjectURL(url);
  }
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
      // Not getTextContent: it `for await`s a ReadableStream, which WebKit (the macOS webview) can't iterate.
      const reader = (await pdf.getPage(i)).streamTextContent().getReader() as ReadableStreamDefaultReader<Awaited<ReturnType<PDFPageProxy["getTextContent"]>>>;
      let text = "";
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        for (const it of chunk.value.items) if ("str" in it) text += it.str + (it.hasEOL ? "\n" : "");
      }
      pages.push(`--- Page ${i} ---\n${text.trim()}`);
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}
