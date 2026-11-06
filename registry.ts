import type {
  AgentMode,
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ModelInfo,
  ProviderStatus,
  Run,
  ToolCallRequest,
} from "../types";
import type { HeliosConfig, ResolvedCandidate, RouteKind } from "../config";
import { resolveRouteCandidates } from "../config";
import type { SecretStore } from "../secrets";
import type { Store } from "../db/store";
import type { Logger } from "../logger";
import { ProviderError, type FetchLike } from "./http";
import { OpenAiCompatibleProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { OllamaProvider } from "./ollama";

export interface ProviderRegistryOptions {
  config: HeliosConfig;
  secrets: SecretStore;
  store: Store;
  logger: Logger;
  fetchImpl?: FetchLike;
}

export interface StreamMeta {
  runId?: string | null;
  sessionId?: string | null;
}

const MODEL_CACHE_TTL_MS = 5 * 60_000;

export function routeKindForMode(mode: AgentMode): RouteKind {
  switch (mode) {
    case "plan":
    case "autonomous":
      return "planning";
    case "review":
    case "ask":
    case "research":
      return "reasoning";
    case "debug":
    case "code":
      return "coding";
    default:
      return "coding";
  }
}

export class ProviderRegistry {
  private config: HeliosConfig;
  private readonly cache = new Map<string, ChatProvider>();
  private modelCache: { at: number; models: ModelInfo[] } | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;

  constructor(private readonly options: ProviderRegistryOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.logger = options.logger.child("providers");
  }

  updateConfig(config: HeliosConfig): void {
    this.config = config;
    this.cache.clear();
    this.modelCache = null;
  }

  getConfig(): HeliosConfig {
    return this.config;
  }

  hasCredentials(providerId: string): boolean {
    const provider = this.config.providers[providerId];
    if (!provider) return false;
    if (!provider.requiresKey) return true;
    return this.options.secrets.has(providerId, provider.apiKeyEnv);
  }

  configuredProviderIds(): string[] {
    return Object.keys(this.config.providers).filter((id) => this.hasCredentials(id));
  }

  provider(providerId: string): ChatProvider {
    const existing = this.cache.get(providerId);
    if (existing) return existing;
    const config = this.config.providers[providerId];
    if (!config) throw new ProviderError(providerId, `Unknown provider "${providerId}"`);
    const apiKey = this.options.secrets.resolve(providerId, config.apiKeyEnv);
    if (config.requiresKey && !apiKey) {
      throw new ProviderError(
        providerId,
        `Provider "${providerId}" has no API key. Set ${config.apiKeyEnv ?? "its key"} or add it in Settings.`,
      );
    }
    const common = {
      id: providerId,
      label: providerId,
      baseUrl: config.baseUrl,
      apiKey,
      headers: config.headers,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.config.limits.llmTimeoutMs,
      supportsTools: config.supportsTools ?? true,
    };
    let provider: ChatProvider;
    switch (config.kind) {
      case "anthropic":
        provider = new AnthropicProvider(common);
        break;
      case "gemini":
        provider = new GeminiProvider(common);
        break;
      case "ollama":
        provider = new OllamaProvider(common);
        break;
      default:
        provider = new OpenAiCompatibleProvider(common);
        break;
    }
    this.cache.set(providerId, provider);
    return provider;
  }

  async providerStatuses(): Promise<ProviderStatus[]> {
    return Object.entries(this.config.providers).map(([id, config]) => ({
      id,
      label: id,
      kind: config.kind,
      configured: this.hasCredentials(id),
      baseUrl: config.baseUrl,
      models: config.models,
      note: config.notes,
    }));
  }

  async listModels(forceRefresh = false): Promise<ModelInfo[]> {
    if (!forceRefresh && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
      return this.modelCache.models;
    }
    const configured = this.configuredProviderIds();
    const all: ModelInfo[] = [];
    await Promise.all(
      configured.map(async (id) => {
        const fallback: ModelInfo[] = (this.config.providers[id]?.models ?? []).map((m) => ({
          providerId: id,
          id: m,
          label: m,
          supportsTools: this.config.providers[id]?.supportsTools ?? true,
          supportsEmbeddings: false,
        }));
        try {
          const discovered = await this.provider(id).listModels();
          if (discovered.length > 0) {
            const seen = new Set(discovered.map((m) => m.id));
            all.push(...discovered, ...fallback.filter((f) => !seen.has(f.id)));
            return;
          }
        } catch (error) {
          this.logger.debug("model discovery failed", { provider: id, error: String(error) });
        }
        all.push(...fallback);
      }),
    );
    const deduped = new Map<string, ModelInfo>();
    for (const m of all) deduped.set(`${m.providerId}:${m.id}`, m);
    const models = [...deduped.values()].sort(
      (a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id),
    );
    this.modelCache = { at: Date.now(), models };
    return models;
  }

  private candidateConfigured(candidate: ResolvedCandidate): boolean {
    return (
      !!this.config.providers[candidate.providerId] && this.hasCredentials(candidate.providerId)
    );
  }

  resolveForKind(kind: RouteKind): ResolvedCandidate[] {
    const configured = this.configuredProviderIds();
    return resolveRouteCandidates(this.config, kind, configured).filter((c) =>
      this.candidateConfigured(c),
    );
  }

  resolveRunTarget(input: {
    providerId?: string | null;
    model?: string | null;
    mode: AgentMode;
  }): ResolvedCandidate {
    if (input.providerId) {
      const provider = this.config.providers[input.providerId];
      if (!provider) throw new Error(`Unknown provider "${input.providerId}"`);
      if (!this.hasCredentials(input.providerId)) {
        throw new Error(
          `Provider "${input.providerId}" is not configured. Add its API key in Settings or set ${
            provider.apiKeyEnv ?? "the provider key environment variable"
          }.`,
        );
      }
      const model = input.model || provider.defaultModel || provider.models[0];
      if (!model) {
        throw new Error(
          `No model specified for provider "${input.providerId}" and no default is configured.`,
        );
      }
      return { providerId: input.providerId, model };
    }
    if (input.model) {
      for (const [id, provider] of Object.entries(this.config.providers)) {
        if (!this.hasCredentials(id)) continue;
        if (
          provider.defaultModel === input.model ||
          provider.models.includes(input.model)
        ) {
          return { providerId: id, model: input.model };
        }
      }
      const configured = this.configuredProviderIds();
      if (configured.length === 1 && configured[0]) {
        return { providerId: configured[0], model: input.model };
      }
      const embedded = input.model.includes("/")
        ? input.model.split("/")[0]
        : input.model.includes(":")
          ? input.model.split(":")[0]
          : null;
      if (embedded && this.config.providers[embedded] && this.hasCredentials(embedded)) {
        return { providerId: embedded, model: input.model };
      }
      throw new Error(
        `Cannot determine which provider serves model "${input.model}". Specify provider and model explicitly.`,
      );
    }
    const candidates = this.resolveForKind(routeKindForMode(input.mode));
    if (candidates.length === 0) {
      throw new Error(
        "No model provider is configured. Add an API key (Settings) or start a local Ollama server, then retry.",
      );
    }
    return candidates[0]!;
  }

  estimateCost(model: string, tokensIn: number, tokensOut: number): number {
    const exact = this.config.pricing[model];
    const pricing =
      exact ??
      Object.entries(this.config.pricing).find(([key]) => model.startsWith(key))?.[1] ??
      null;
    if (!pricing) return 0;
    return (tokensIn / 1_000_000) * pricing.in + (tokensOut / 1_000_000) * pricing.out;
  }

  async *streamFor(target: ResolvedCandidate, request: ChatRequest, meta?: StreamMeta): AsyncGenerator<ChatStreamEvent> {
    const provider = this.provider(target.providerId);
    let recorded = false;
    for await (const event of provider.stream({ ...request, model: target.model })) {
      if (event.type === "usage" && !recorded) {
        recorded = true;
        const cost = this.estimateCost(target.model, event.usage.tokensIn, event.usage.tokensOut);
        try {
          this.options.store.addUsage({
            runId: meta?.runId ?? null,
            sessionId: meta?.sessionId ?? null,
            providerId: target.providerId,
            model: target.model,
            tokensIn: event.usage.tokensIn,
            tokensOut: event.usage.tokensOut,
            costUsd: cost,
          });
          if (meta?.runId) {
            this.options.store.addRunUsage(
              meta.runId,
              event.usage.tokensIn,
              event.usage.tokensOut,
              cost,
            );
          }
        } catch (error) {
          this.logger.warn("failed to record usage", { error: String(error) });
        }
      }
      yield event;
    }
  }

  async complete(
    target: ResolvedCandidate,
    request: ChatRequest,
    meta?: StreamMeta,
  ): Promise<ChatResponse> {
    let text = "";
    const toolCalls: ToolCallRequest[] = [];
    let usage = { tokensIn: 0, tokensOut: 0 };
    let finishReason = "stop";
    for await (const event of this.streamFor(target, request, meta)) {
      if (event.type === "text") text += event.text;
      else if (event.type === "tool_call") toolCalls.push(event.call);
      else if (event.type === "usage") usage = event.usage;
      else if (event.type === "done") finishReason = event.finishReason;
    }
    return { text, toolCalls, usage, finishReason };
  }

  /** Completes using the configured routing for a task kind, falling back across candidates. */
  async completeForKind(
    kind: RouteKind,
    request: Omit<ChatRequest, "model">,
    meta?: StreamMeta,
  ): Promise<{ target: ResolvedCandidate; response: ChatResponse }> {
    const candidates = this.resolveForKind(kind);
    if (candidates.length === 0) {
      throw new Error("No model provider is configured for this operation.");
    }
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const response = await this.complete(candidate, { ...request, model: candidate.model }, meta);
        return { target: candidate, response };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        this.logger.warn("model candidate failed", {
          provider: candidate.providerId,
          model: candidate.model,
          error: message,
        });
      }
    }
    throw new Error(`All model candidates failed:\n${errors.join("\n")}`);
  }

  async embed(
    texts: string[],
  ): Promise<{ model: string; vectors: number[][]; providerId: string } | null> {
    if (texts.length === 0) return null;
    if (this.config.memory.embeddings === "off") return null;
    const preferred = this.resolveForKind("embedding");
    const candidates: ResolvedCandidate[] = [
      ...preferred,
      ...this.configuredProviderIds().map((id) => ({
        providerId: id,
        model: this.config.memory.embeddingModel ?? "",
      })),
    ];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const provider = this.config.providers[candidate.providerId];
      if (!provider) continue;
      const key = candidate.providerId;
      if (seen.has(key)) continue;
      seen.add(key);
      let instance: ChatProvider;
      try {
        instance = this.provider(candidate.providerId);
      } catch {
        continue;
      }
      if (!instance.embed) continue;
      const model =
        candidate.model || this.config.memory.embeddingModel || instance.defaultEmbeddingModel?.();
      if (!model) continue;
      try {
        const vectors = await instance.embed(texts, model);
        if (vectors.length === texts.length) {
          return { model, vectors, providerId: candidate.providerId };
        }
      } catch (error) {
        this.logger.debug("embedding candidate failed", {
          provider: candidate.providerId,
          model,
          error: String(error),
        });
      }
    }
    return null;
  }
}

export function runCostSnapshot(run: Run, config: HeliosConfig): number {
  const pricing = config.pricing[run.model ?? ""];
  if (!pricing) return run.costUsd;
  return (run.tokensIn / 1_000_000) * pricing.in + (run.tokensOut / 1_000_000) * pricing.out;
}
