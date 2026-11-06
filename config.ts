import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { z } from "zod";
import type {
  AgentMode,
  PolicyDecision,
  ProviderKind,
  RiskLevel,
} from "./types";
import { resolveHeliosPaths, type HeliosPaths } from "./paths";

export type RouteKind =
  | "planning"
  | "coding"
  | "reasoning"
  | "summarization"
  | "classification"
  | "embedding";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKeyEnv?: string;
  requiresKey: boolean;
  models: string[];
  defaultModel?: string;
  headers?: Record<string, string>;
  supportsTools?: boolean;
  notes?: string;
}

export interface HeliosConfig {
  version: 1;
  server: { host: string; port: number };
  providers: Record<string, ProviderConfig>;
  routing: Record<RouteKind, string[]>;
  permissions: Record<RiskLevel, PolicyDecision>;
  modePolicy: Record<AgentMode, Record<RiskLevel, PolicyDecision>>;
  limits: {
    maxTasksPerRun: number;
    maxStepsPerTask: number;
    maxToolCallsPerRun: number;
    maxReplans: number;
    llmTimeoutMs: number;
    toolTimeoutMs: number;
    shellTimeoutMs: number;
    approvalTimeoutMs: number;
    maxRunMinutes: number;
    contextChars: number;
    maxFileBytes: number;
    maxToolOutputChars: number;
  };
  verification: {
    autoRun: boolean;
    commands: { test: string | null; build: string | null; typecheck: string | null; lint: string | null };
    detectFromProject: boolean;
  };
  memory: {
    embeddings: "auto" | "off" | "provider";
    embeddingModel: string | null;
    maxRecords: number;
    retrievalLimit: number;
    minImportance: number;
    vectorWeight: number;
    keywordWeight: number;
    extraction: boolean;
  };
  shell: {
    sanitizeEnv: boolean;
    allowEnvVars: string[];
    extraDenyPatterns: string[];
  };
  security: {
    networkAllowlist: string[];
    networkDenylist: string[];
    maxWebBytes: number;
  };
  pricing: Record<string, { in: number; out: number }>;
}

export const PROVIDER_PRESETS: Record<string, ProviderConfig> = {
  anthropic: {
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    requiresKey: true,
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
    defaultModel: "claude-sonnet-4-5",
    supportsTools: true,
  },
  openai: {
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    requiresKey: true,
    models: ["gpt-5.1", "gpt-5-mini", "gpt-4.1", "o4-mini"],
    defaultModel: "gpt-5-mini",
    supportsTools: true,
  },
  google: {
    kind: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    requiresKey: true,
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    defaultModel: "gemini-2.5-flash",
    supportsTools: true,
  },
  ollama: {
    kind: "ollama",
    baseUrl: "http://localhost:11434",
    requiresKey: false,
    models: [],
    supportsTools: true,
    notes: "Local models. Model list is discovered from the running Ollama daemon.",
  },
  openrouter: {
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    requiresKey: true,
    models: [],
    supportsTools: true,
  },
  groq: {
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    requiresKey: true,
    models: ["llama-3.3-70b-versatile", "qwen-2.5-coder-32b"],
    defaultModel: "llama-3.3-70b-versatile",
    supportsTools: true,
  },
  deepseek: {
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    requiresKey: true,
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    supportsTools: true,
  },
  mistral: {
    kind: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    requiresKey: true,
    models: ["mistral-large-latest", "codestral-latest"],
    defaultModel: "mistral-large-latest",
    supportsTools: true,
  },
  xai: {
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    requiresKey: true,
    models: ["grok-4", "grok-3-mini"],
    defaultModel: "grok-4",
    supportsTools: true,
  },
  together: {
    kind: "openai",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    requiresKey: true,
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-Coder-32B-Instruct"],
    supportsTools: true,
  },
  fireworks: {
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    requiresKey: true,
    models: ["accounts/fireworks/models/deepseek-v3"],
    supportsTools: true,
  },
  cerebras: {
    kind: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    requiresKey: true,
    models: ["llama-3.3-70b", "qwen-3-32b"],
    supportsTools: true,
  },
  perplexity: {
    kind: "openai",
    baseUrl: "https://api.perplexity.ai",
    apiKeyEnv: "PERPLEXITY_API_KEY",
    requiresKey: true,
    models: ["sonar-pro", "sonar"],
    supportsTools: false,
  },
  lmstudio: {
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    requiresKey: false,
    models: [],
    supportsTools: true,
    notes: "Local OpenAI-compatible server. Start LM Studio with the local server enabled.",
  },
  vllm: {
    kind: "openai",
    baseUrl: "http://localhost:8000/v1",
    requiresKey: false,
    models: [],
    supportsTools: true,
    notes: "Local vLLM OpenAI-compatible server.",
  },
};

export function defaultConfig(): HeliosConfig {
  const allow: Record<RiskLevel, PolicyDecision> = {
    read: "allow",
    write: "allow",
    destructive: "ask",
    network: "ask",
    external: "ask",
  };
  const readOnly: Record<RiskLevel, PolicyDecision> = {
    read: "allow",
    write: "deny",
    destructive: "deny",
    network: "ask",
    external: "deny",
  };
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 4319 },
    providers: structuredClone(PROVIDER_PRESETS),
    routing: {
      planning: [],
      coding: [],
      reasoning: [],
      summarization: [],
      classification: [],
      embedding: [],
    },
    permissions: allow,
    modePolicy: {
      ask: readOnly,
      plan: readOnly,
      review: readOnly,
      research: { ...readOnly, network: "allow" },
      code: allow,
      debug: allow,
      autonomous: allow,
    },
    limits: {
      maxTasksPerRun: 12,
      maxStepsPerTask: 40,
      maxToolCallsPerRun: 400,
      maxReplans: 2,
      llmTimeoutMs: 240_000,
      toolTimeoutMs: 180_000,
      shellTimeoutMs: 120_000,
      approvalTimeoutMs: 900_000,
      maxRunMinutes: 120,
      contextChars: 48_000,
      maxFileBytes: 256_000,
      maxToolOutputChars: 24_000,
    },
    verification: {
      autoRun: true,
      commands: { test: null, build: null, typecheck: null, lint: null },
      detectFromProject: true,
    },
    memory: {
      embeddings: "auto",
      embeddingModel: null,
      maxRecords: 5_000,
      retrievalLimit: 8,
      minImportance: 0.3,
      vectorWeight: 0.45,
      keywordWeight: 0.35,
      extraction: true,
    },
    shell: {
      sanitizeEnv: true,
      allowEnvVars: [],
      extraDenyPatterns: [],
    },
    security: {
      networkAllowlist: [],
      networkDenylist: [],
      maxWebBytes: 2_000_000,
    },
    pricing: {
      "claude-sonnet-4-5": { in: 3, out: 15 },
      "claude-opus-4-1": { in: 15, out: 75 },
      "claude-haiku-4-5": { in: 1, out: 5 },
      "gpt-5.1": { in: 1.25, out: 10 },
      "gpt-5-mini": { in: 0.25, out: 2 },
      "gpt-4.1": { in: 2, out: 8 },
      "o4-mini": { in: 1.1, out: 4.4 },
      "gemini-2.5-pro": { in: 1.25, out: 10 },
      "gemini-2.5-flash": { in: 0.3, out: 2.5 },
      "deepseek-chat": { in: 0.28, out: 0.42 },
      "deepseek-reasoner": { in: 0.28, out: 0.42 },
    },
  };
}

const providerSchema = z.object({
  kind: z.enum(["openai", "anthropic", "gemini", "ollama"]),
  baseUrl: z.string().min(1),
  apiKeyEnv: z.string().optional(),
  requiresKey: z.boolean().default(false),
  models: z.array(z.string()).default([]),
  defaultModel: z.string().optional(),
  headers: z.record(z.string()).optional(),
  supportsTools: z.boolean().optional(),
  notes: z.string().optional(),
});

const riskPolicySchema = z.object({
  read: z.enum(["allow", "ask", "deny"]),
  write: z.enum(["allow", "ask", "deny"]),
  destructive: z.enum(["allow", "ask", "deny"]),
  network: z.enum(["allow", "ask", "deny"]),
  external: z.enum(["allow", "ask", "deny"]),
});

const configSchema = z.object({
  version: z.literal(1),
  server: z.object({ host: z.string(), port: z.number().int().positive().max(65535) }),
  providers: z.record(providerSchema),
  routing: z.object({
    planning: z.array(z.string()),
    coding: z.array(z.string()),
    reasoning: z.array(z.string()),
    summarization: z.array(z.string()),
    classification: z.array(z.string()),
    embedding: z.array(z.string()),
  }),
  permissions: riskPolicySchema,
  modePolicy: z.record(riskPolicySchema),
  limits: z.object({
    maxTasksPerRun: z.number().int().positive(),
    maxStepsPerTask: z.number().int().positive(),
    maxToolCallsPerRun: z.number().int().positive(),
    maxReplans: z.number().int().min(0),
    llmTimeoutMs: z.number().int().positive(),
    toolTimeoutMs: z.number().int().positive(),
    shellTimeoutMs: z.number().int().positive(),
    approvalTimeoutMs: z.number().int().positive(),
    maxRunMinutes: z.number().int().positive(),
    contextChars: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    maxToolOutputChars: z.number().int().positive(),
  }),
  verification: z.object({
    autoRun: z.boolean(),
    commands: z.object({
      test: z.string().nullable(),
      build: z.string().nullable(),
      typecheck: z.string().nullable(),
      lint: z.string().nullable(),
    }),
    detectFromProject: z.boolean(),
  }),
  memory: z.object({
    embeddings: z.enum(["auto", "off", "provider"]),
    embeddingModel: z.string().nullable(),
    maxRecords: z.number().int().positive(),
    retrievalLimit: z.number().int().positive(),
    minImportance: z.number().min(0).max(1),
    vectorWeight: z.number().min(0).max(1),
    keywordWeight: z.number().min(0).max(1),
    extraction: z.boolean(),
  }),
  shell: z.object({
    sanitizeEnv: z.boolean(),
    allowEnvVars: z.array(z.string()),
    extraDenyPatterns: z.array(z.string()),
  }),
  security: z.object({
    networkAllowlist: z.array(z.string()),
    networkDenylist: z.array(z.string()),
    maxWebBytes: z.number().int().positive(),
  }),
  pricing: z.record(z.object({ in: z.number(), out: z.number() })),
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  if (!isPlainObject(base)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

export interface LoadedConfig {
  config: HeliosConfig;
  paths: HeliosPaths;
  source: "default" | "file";
}

export function validateConfig(input: unknown): HeliosConfig {
  return configSchema.parse(input) as HeliosConfig;
}

export function loadConfig(options?: { home?: string; path?: string }): LoadedConfig {
  const paths = resolveHeliosPaths(options?.home);
  const configPath = options?.path ?? paths.configPath;
  const base = defaultConfig();
  let config = base;
  let source: "default" | "file" = "default";
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    config = deepMerge(base, raw);
    source = "file";
  }
  if (process.env.HELIOS_PORT) config.server.port = Number(process.env.HELIOS_PORT);
  if (process.env.HELIOS_HOST) config.server.host = process.env.HELIOS_HOST;
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid Project Helios configuration at ${configPath}: ${details}`);
  }
  return { config: parsed.data as HeliosConfig, paths, source };
}

export function saveConfig(config: HeliosConfig, paths: HeliosPaths): void {
  const tmp = `${paths.configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(tmp, paths.configPath);
  try {
    chmodSync(paths.configPath, 0o600);
  } catch {
    // chmod is best-effort on platforms without POSIX permissions
  }
}

export interface ResolvedCandidate {
  providerId: string;
  model: string;
}

export function parseModelRef(ref: string): ResolvedCandidate | null {
  const idx = ref.indexOf(":");
  if (idx <= 0) return null;
  const providerId = ref.slice(0, idx).trim();
  const model = ref.slice(idx + 1).trim();
  if (!providerId || !model) return null;
  return { providerId, model };
}

/** Resolves configured routing candidates for a task kind, falling back to configured providers. */
export function resolveRouteCandidates(
  config: HeliosConfig,
  kind: RouteKind,
  configuredProviders: string[],
): ResolvedCandidate[] {
  const out: ResolvedCandidate[] = [];
  for (const ref of config.routing[kind] ?? []) {
    const parsed = parseModelRef(ref);
    if (parsed && config.providers[parsed.providerId]) out.push(parsed);
  }
  if (out.length > 0) return out;
  for (const id of configuredProviders) {
    const p = config.providers[id];
    if (!p) continue;
    if (p.defaultModel) out.push({ providerId: id, model: p.defaultModel });
  }
  return out;
}
