// AI titles for the sidebar: what the model sees, and cleaning up what it says back.

const clip = (s: string, n = 1500) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** The start of a conversation, as the titler sees it. */
export function titleInput(messages: { role: string; content: string }[], materialNames: string[] = []): string {
  const student = messages.find((m) => m.role === "user")?.content.trim();
  const tutor = messages.find((m) => m.role === "assistant" && m.content.trim())?.content.trim();
  return [
    student && `Student: ${clip(student)}`,
    materialNames.length > 0 && `Course material they attached: ${materialNames.join(", ")}`,
    tutor && `Tutor: ${clip(tutor)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The title on the model's first line, without the quotes, labels, and punctuation models like to add. */
export function cleanTitle(raw: string): string {
  const line = raw.replace(/<think>[\s\S]*?<\/think>/g, "").split("\n").find((l) => l.trim()) ?? "";
  const title = line
    .replace(/\*\*/g, "")
    .replace(/^\s*(#+\s*)?(title:\s*)?/i, "")
    .replace(/^["'“‘`]+|["'”’`]+$/g, "")
    .replace(/[.!]+$/, "")
    .trim();
  return title.length > 60 ? `${title.slice(0, 57).trimEnd()}...` : title;
}
