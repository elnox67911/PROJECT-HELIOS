import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
  ChatStreamEvent,
  ModelInfo,
  ToolCallRequest,
  Usage,
} from "../types";
import {
  type FetchLike,
  ProviderError,
  normalizeBaseUrl,
  parseSse,
  requestJson,
  requestStream,
  tryParseJsonObject,
} from "./http";

export interface OpenAiCompatibleOptions {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string | null;
  headers?: Record<string, string>;
  fetchImpl: FetchLike;
  timeoutMs: number;
  supportsTools: boolean;
  supportsEmbeddings?: boolean;
  extraBody?: Record<string, unknown>;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly kind = "openai" as const;
  readonly supportsTools: boolean;
  readonly supportsEmbeddings: boolean;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.supportsTools = options.supportsTools;
    this.supportsEmbeddings = options.supportsEmbeddings ?? true;
  }

  get id(): string {
    return this.options.id;
  }
  get label(): string {
    return this.options.label;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.options.headers ?? {}),
    };
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
    return headers;
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await requestJson<{ data?: Array<{ id?: string }>; models?: Array<{ id?: string }> }>(
      this.options.fetchImpl,
      this.id,
      `${this.baseUrl}/models`,
      {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    const list = data.data ?? data.models ?? [];
    return list
      .filter((m): m is { id: string } => typeof m.id === "string")
      .map((m) => ({
        providerId: this.id,
        id: m.id,
        label: m.id,
        supportsTools: this.supportsTools,
        supportsEmbeddings: this.supportsEmbeddings,
      }));
  }

  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(this.options.extraBody ?? {}),
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.reasoningEffort) body.reasoning_effort = request.reasoningEffort;
    if (request.tools && request.tools.length > 0 && this.supportsTools) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const response = await requestStream(
      this.options.fetchImpl,
      this.id,
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage = { tokensIn: 0, tokensOut: 0 };
    let finishReason = "stop";

    for await (const evt of parseSse(response)) {
      if (evt.data === "[DONE]") break;
      let json: any;
      try {
        json = JSON.parse(evt.data);
      } catch {
        continue;
      }
      if (json.error) {
        throw new ProviderError(this.id, `${this.id}: ${json.error.message ?? "stream error"}`);
      }
      const choice = json.choices?.[0];
      if (choice?.delta?.content) {
        yield { type: "text", text: String(choice.delta.content) };
      }
      const deltas = choice?.delta?.tool_calls as OpenAiToolCallDelta[] | undefined;
      if (Array.isArray(deltas)) {
        for (const delta of deltas) {
          const index = delta.index ?? 0;
          const current = calls.get(index) ?? { id: "", name: "", args: "" };
          if (delta.id) current.id = delta.id;
          if (delta.function?.name) current.name = delta.function.name;
          if (delta.function?.arguments) current.args += delta.function.arguments;
          calls.set(index, current);
        }
      }
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
      if (json.usage) {
        usage = {
          tokensIn: Number(json.usage.prompt_tokens ?? 0),
          tokensOut: Number(json.usage.completion_tokens ?? 0),
        };
      }
    }

    for (const call of calls.values()) {
      if (!call.name) continue;
      const parsed: ToolCallRequest = {
        id: call.id || `call_${randomUUID()}`,
        name: call.name,
        arguments: tryParseJsonObject(call.args),
      };
      yield { type: "tool_call", call: parsed };
    }
    if (usage.tokensIn > 0 || usage.tokensOut > 0) yield { type: "usage", usage };
    yield { type: "done", finishReason };
  }

  async embed(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]> {
    if (!this.supportsEmbeddings) {
      throw new ProviderError(this.id, `${this.id} does not support embeddings`);
    }
    if (!model) throw new ProviderError(this.id, `${this.id}: an embedding model is required`);
    const data = await requestJson<{ data: Array<{ index: number; embedding: number[] }> }>(
      this.options.fetchImpl,
      this.id,
      `${this.baseUrl}/embeddings`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model, input: texts }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)])
          : AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    return data.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }

  defaultEmbeddingModel(): string | null {
    return this.supportsEmbeddings ? "text-embedding-3-small" : null;
  }
}
