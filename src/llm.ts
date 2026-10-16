// Provider-neutral chat types. These are the shapes stored in SQLite, so keep them stable.

export type ToolCall = { function: { name: string; arguments: Record<string, any> } };

export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
};

export type Tool = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** A model as the picker and settings see it: which provider serves it, and its name there. */
export type ModelRef = { provider: string; model: string };

export type ChatRequest = {
  model: string;
  system: string;
  messages: Message[];
  tools: Tool[];
  signal: AbortSignal;
  onDelta?: (m: Message) => void;
};

export type ResearchRequest = { model: string; system: string; question: string; signal: AbortSignal };

/** A picture as base64, without the data: URL prefix. */
export type ImageData = { mime: string; data: string };

export type TranscribeRequest = { model: string; system: string; image: ImageData };

export type CompleteRequest = { model: string; system: string; prompt: string };

/** An LLM backend. Dusty owns the agent loop; a provider only produces one assistant turn at a time. */
export interface Provider {
  id: string;
  label: string;
  /** A cheap model for small chores like titles. Without one, the selected model does them. */
  quickModel?: string;
  /** Throws when the provider isn't reachable or set up. */
  listModels(): Promise<string[]>;
  /** What the student has to do before this provider works, if anything. */
  setupHint(): Promise<string | null>;
  /** Streams one assistant turn, accumulating content, thinking, and tool calls. */
  chat(req: ChatRequest): Promise<Message>;
  /** Answers a self-contained question from the web and returns a sourced brief. */
  research(req: ResearchRequest): Promise<string>;
  /** Turns a picture into text. Throws when the model can't see images. */
  transcribe(req: TranscribeRequest): Promise<string>;
  /** One plain-text reply to one prompt, without tools. */
  complete(req: CompleteRequest): Promise<string>;
}
