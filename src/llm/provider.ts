// src/llm/provider.ts
// One chat() call the rest of the codebase uses, backed by either Ollama or any
// OpenAI-compatible endpoint.

import { Ollama } from "ollama";
import { config } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Ollama's sampling knobs, as used by the existing call sites. */
export interface ChatOptions {
  temperature?: number;
  repeat_penalty?: number;
  num_predict?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Ollama-only reasoning control. Ignored by OpenAI-compatible endpoints. */
  think?: boolean | "low" | "medium" | "high";
  format?: "json";
  options?: ChatOptions;
}

export interface ChatResponse {
  message: { content: string };
}

const ollama = new Ollama({ host: config.ollama.host });

/** Body for POST {baseUrl}/chat/completions.
 *
 *  Pure and exported so the mapping is testable without a network or a key.
 */
export function toOpenAIRequest(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
  };
  if (req.format === "json") body.response_format = { type: "json_object" };
  if (req.options?.temperature !== undefined) body.temperature = req.options.temperature;
  if (req.options?.num_predict !== undefined) body.max_tokens = req.options.num_predict;
  return body;
}

/** Pull the assistant text out of an OpenAI chat completion. */
export function fromOpenAIResponse(data: unknown): ChatResponse {
  const choice = (data as { choices?: Array<{ message?: { content?: string | null } }> })?.choices?.[0];
  return { message: { content: choice?.message?.content ?? "" } };
}

async function openAIChat(req: ChatRequest): Promise<ChatResponse> {
  const baseUrl = config.llm.baseUrl || config.openai.baseUrl;
  const apiKey = config.llm.apiKey || config.openai.apiKey;

  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(toOpenAIRequest(req)),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OpenAI request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
    );
  }

  return fromOpenAIResponse(await res.json());
}

/** Send a chat request to whichever provider is configured. */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  if (config.llm.provider === "openai") return openAIChat(req);
  return (await ollama.chat({ ...req, stream: false })) as ChatResponse;
}

/** Fail at startup, not on the first decision. */
export function assertProviderConfigured(): void {
  if (config.llm.provider !== "openai") return;

  const apiKey = config.llm.apiKey || config.openai.apiKey;
  const plannerModel = config.llm.models.planner || config.openai.model;

  if (!apiKey) {
    console.warn(
      "[LLM Warning] Cảnh báo: API Key đang để trống. Nếu server AI của bạn không yêu cầu Key (VD: vLLM/Local API) thì có thể bỏ qua."
    );
  }

  if (!plannerModel) {
    throw new Error(
      "LLM_PROVIDER=openai nhưng Model chưa được cấu hình. Hãy nhập tên Model khi CLI khởi động."
    );
  }
}
