import { getSetting } from "../db";
import type { ModelRef, Provider } from "../llm";
import { claudeCode } from "./claudeCode";
import { ollama } from "./ollama";

export const PROVIDERS: Provider[] = [ollama, claudeCode];

export const DEFAULT_MODEL: ModelRef = { provider: "ollama", model: "gpt-oss:120b" };

export function getProvider(id: string): Provider {
  const p = PROVIDERS.find((p) => p.id === id);
  if (!p) throw new Error(`Unknown model provider: ${id}`);
  return p;
}

/** Models from every provider that's reachable; one being down doesn't hide the others. */
export async function listAllModels(): Promise<ModelRef[]> {
  const lists = await Promise.allSettled(PROVIDERS.map((p) => p.listModels()));
  return PROVIDERS.flatMap((p, i) => {
    const r = lists[i];
    return r.status === "fulfilled" ? r.value.map((model) => ({ provider: p.id, model })) : [];
  });
}

/** The selected model. Older versions stored a bare Ollama model name. */
export async function readModel(): Promise<ModelRef> {
  const v = await getSetting<ModelRef | string>("model", DEFAULT_MODEL);
  return typeof v === "string" ? { provider: "ollama", model: v } : v;
}

export const sameModel = (a: ModelRef, b: ModelRef) => a.provider === b.provider && a.model === b.model;
