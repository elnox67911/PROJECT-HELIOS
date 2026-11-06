import { HeliosDatabase } from "./db/database";
import { Store } from "./db/store";
import {
  deepMerge,
  loadConfig,
  saveConfig,
  validateConfig,
  type HeliosConfig,
} from "./config";
import { Logger } from "./logger";
import { ensureHeliosDirs, resolveHeliosPaths, type HeliosPaths } from "./paths";
import { SecretStore } from "./secrets";
import { ProviderRegistry } from "./providers/registry";
import { createToolRegistry } from "./tools";
import type { ToolRegistry } from "./tools/registry";
import { RepoIndexer } from "./context/indexer";
import { ContextAssembler } from "./context/assembler";
import { EmbeddingService } from "./memory/embedding";
import { MemoryManager } from "./memory/memory-manager";
import { AgentRuntime } from "./runtime/runtime";
import { EventBus } from "./runtime/events";
import { createSummarizer } from "./runtime/model";
import { SelfImprovementEngine } from "./insights/improvement";
import { MetricsService } from "./insights/metrics";

export interface CreateHeliosOptions {
  /** Overrides HELIOS_HOME / ~/.helios. */
  home?: string;
  /** Overrides the config file path (used by tests). */
  configPath?: string;
  logger?: Logger;
}

/**
 * Composition root shared by the HTTP server, the CLI, and tests. Every
 * subsystem points at the same store, config object, secret store, and event
 * bus so config changes and events are observed consistently.
 */
export class HeliosApp {
  readonly paths: HeliosPaths;
  readonly logger: Logger;
  readonly db: HeliosDatabase;
  readonly store: Store;
  readonly secrets: SecretStore;
  readonly registry: ProviderRegistry;
  readonly tools: ToolRegistry;
  readonly embedder: EmbeddingService;
  readonly memory: MemoryManager;
  readonly indexer: RepoIndexer;
  readonly assembler: ContextAssembler;
  readonly events: EventBus;
  readonly runtime: AgentRuntime;
  readonly improvement: SelfImprovementEngine;
  readonly metrics: MetricsService;
  readonly configSource: "default" | "file";
  readonly config: HeliosConfig;
  private closed = false;

  private constructor(options: CreateHeliosOptions, loaded: ReturnType<typeof loadConfig>) {
    this.paths = loaded.paths;
    ensureHeliosDirs(this.paths);
    this.config = loaded.config;
    this.configSource = loaded.source;
    this.logger = options.logger ?? new Logger("helios");

    this.db = new HeliosDatabase(this.paths.dbPath);
    this.store = new Store(this.db);
    this.secrets = new SecretStore(this.paths);
    this.registry = new ProviderRegistry({
      config: this.config,
      secrets: this.secrets,
      store: this.store,
      logger: this.logger,
    });
    this.tools = createToolRegistry(this.logger);
    this.embedder = new EmbeddingService(this.registry, this.config, this.logger);
    this.memory = new MemoryManager({
      store: this.store,
      config: this.config,
      logger: this.logger,
      embedder: this.embedder,
      model: createSummarizer(this.registry, null),
    });
    this.indexer = new RepoIndexer({
      store: this.store,
      config: this.config,
      logger: this.logger,
    });
    this.assembler = new ContextAssembler({
      store: this.store,
      config: this.config,
      logger: this.logger,
      indexer: this.indexer,
      memory: this.memory,
    });
    this.events = new EventBus();
    this.improvement = new SelfImprovementEngine({ store: this.store, logger: this.logger });
    this.metrics = new MetricsService(this.store);
    this.runtime = new AgentRuntime({
      store: this.store,
      config: this.config,
      logger: this.logger,
      registry: this.registry,
      tools: this.tools,
      memory: this.memory,
      indexer: this.indexer,
      assembler: this.assembler,
      secrets: this.secrets,
      paths: this.paths,
      eventBus: this.events,
      afterRun: async (runId) => {
        await this.improvement.afterRun(runId);
      },
    });
  }

  static create(options: CreateHeliosOptions = {}): HeliosApp {
    const loaded = loadConfig({
      home: options.home,
      path: options.configPath,
    });
    return new HeliosApp(options, loaded);
  }

  /**
   * Merges a patch into the live configuration, validates it, persists it, and
   * refreshes services that cache derived state. Throws without changing
   * anything when validation fails.
   */
  updateConfig(patch: unknown): HeliosConfig {
    const merged = deepMerge(structuredClone(this.config), patch);
    const validated = validateConfig(merged);
    for (const key of Object.keys(this.config)) {
      delete (this.config as unknown as Record<string, unknown>)[key];
    }
    Object.assign(this.config, validated);
    saveConfig(this.config, this.paths);
    this.registry.updateConfig(this.config);
    this.memory.updateConfig(this.config);
    this.embedder.updateConfig(this.config);
    return this.config;
  }

  /** Re-reads the config file (for external edits) and applies it. */
  reloadConfig(): HeliosConfig {
    const loaded = loadConfig({ home: this.paths.home });
    return this.updateConfig(loaded.config);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const runId of this.runtime.activeRunIds()) {
      this.runtime.cancel(runId);
    }
    this.db.close();
  }
}

export function createHeliosApp(options: CreateHeliosOptions = {}): HeliosApp {
  return HeliosApp.create(options);
}
