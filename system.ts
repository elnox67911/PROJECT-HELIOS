import type { FastifyInstance } from "fastify";
import type { AgentMode, HeliosApp } from "@helios/core";
import {
  HttpError,
  optionalString,
  requireObject,
  requiredString,
} from "../http";

const MODES: AgentMode[] = ["ask", "plan", "code", "autonomous", "debug", "review", "research"];

export async function registerSystemRoutes(server: FastifyInstance, app: HeliosApp): Promise<void> {
  server.get("/api/health", async () => ({
    ok: true,
    name: "Project Helios",
    version: "0.1.0",
    home: app.paths.home,
    database: app.paths.dbPath,
    configSource: app.configSource,
    activeRuns: app.runtime.activeRunIds(),
    modes: MODES,
    time: new Date().toISOString(),
  }));

  server.get("/api/config", async () => ({
    config: app.config,
    source: app.configSource,
  }));

  server.put("/api/config", async (request) => {
    const body = requireObject(request.body);
    const patch = body.patch ?? body.config ?? body;
    const config = app.updateConfig(patch);
    return { config };
  });

  server.post("/api/config/reload", async () => ({
    config: app.reloadConfig(),
    source: "file",
  }));

  server.get("/api/providers", async () => {
    const statuses = await app.registry.providerStatuses();
    const stored = new Set(app.secrets.list());
    return {
      providers: statuses.map((provider) => ({
        ...provider,
        hasStoredKey: stored.has(provider.id),
      })),
    };
  });

  server.post("/api/providers/:id/test", async (request) => {
    const { id } = request.params as { id: string };
    if (!app.config.providers[id]) throw new HttpError(404, `Unknown provider "${id}".`);
    try {
      const provider = app.registry.provider(id);
      const models = await provider.listModels();
      return { ok: true, provider: id, models: models.map((model) => model.id) };
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  });

  server.get("/api/models", async (request) => {
    const query = request.query as { refresh?: string };
    const models = await app.registry.listModels(query.refresh === "1" || query.refresh === "true");
    return { models };
  });

  server.get("/api/tools", async (request) => {
    const query = request.query as { mode?: string };
    const mode = (query.mode && MODES.includes(query.mode as AgentMode)
      ? query.mode
      : "code") as AgentMode;
    const specs = app.tools.specs(mode);
    const definitions = new Map(app.tools.list(mode).map((tool) => [tool.name, tool]));
    return {
      mode,
      tools: specs.map((spec) => {
        const definition = definitions.get(spec.name);
        return {
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          risk:
            definition && typeof definition.risk === "string"
              ? definition.risk
              : "dynamic",
          modes: definition?.modes ?? MODES,
        };
      }),
    };
  });

  server.get("/api/secrets", async () => {
    const stored = new Set(app.secrets.list());
    return {
      providers: Object.entries(app.config.providers).map(([id, provider]) => ({
        id,
        kind: provider.kind,
        requiresKey: provider.requiresKey,
        apiKeyEnv: provider.apiKeyEnv ?? null,
        hasStoredKey: stored.has(id),
        hasEnvKey: Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv]),
        configured: app.registry.hasCredentials(id),
      })),
    };
  });

  server.put("/api/secrets/:providerId", async (request) => {
    const { providerId } = request.params as { providerId: string };
    const body = requireObject(request.body);
    if (!app.config.providers[providerId]) {
      throw new HttpError(404, `Unknown provider "${providerId}".`);
    }
    const apiKey = requiredString(body, "apiKey", 8_000).trim();
    app.secrets.set(providerId, apiKey);
    app.registry.updateConfig(app.config);
    return { ok: true, providerId, configured: app.registry.hasCredentials(providerId) };
  });

  server.delete("/api/secrets/:providerId", async (request) => {
    const { providerId } = request.params as { providerId: string };
    app.secrets.delete(providerId);
    app.registry.updateConfig(app.config);
    return { ok: true, providerId, configured: app.registry.hasCredentials(providerId) };
  });

  server.get("/api/settings/memory", async () => ({
    memory: app.config.memory,
  }));

  server.put("/api/settings/memory", async (request) => {
    const body = requireObject(request.body);
    const config = app.updateConfig({ memory: body });
    return { memory: config.memory };
  });

  server.put("/api/settings/routing", async (request) => {
    const body = requireObject(request.body);
    const kind = optionalString(body, "kind", 40);
    if (!kind) throw new HttpError(400, 'Field "kind" is required.');
    if (!(kind in app.config.routing)) throw new HttpError(400, `Unknown routing kind "${kind}".`);
    const config = app.updateConfig({ routing: { [kind]: body.models ?? [] } });
    return { routing: config.routing };
  });
}
