import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { HeliosApp } from "@helios/core";
import { HttpError } from "./http";
import { registerExecutionRoutes } from "./routes/execution";
import { registerKnowledgeRoutes } from "./routes/knowledge";
import { registerSystemRoutes } from "./routes/system";
import { registerWorkspaceRoutes } from "./routes/workspace";
import { registerStreams } from "./stream";

export interface CreateServerOptions {
  webRoot?: string | null;
  cors?: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = resolve(here, "../../../apps/web/dist");

export async function createServer(
  app: HeliosApp,
  options: CreateServerOptions = {},
): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
  });

  if (options.cors !== false) {
    await server.register(cors, { origin: true });
  }

  server.setErrorHandler((error, request, reply) => {
    const err = error as Error & { statusCode?: number };
    const status =
      err instanceof HttpError
        ? err.statusCode
        : typeof err.statusCode === "number"
          ? err.statusCode
          : 500;
    if (status >= 500) {
      app.logger.error("request failed", {
        method: request.method,
        url: request.url,
        error: err.message,
      });
    }
    reply.code(status).send({ error: err.message });
  });

  await registerSystemRoutes(server, app);
  await registerWorkspaceRoutes(server, app);
  await registerExecutionRoutes(server, app);
  await registerKnowledgeRoutes(server, app);
  registerStreams(server, app);

  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  if (webRoot && existsSync(resolve(webRoot, "index.html"))) {
    await server.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      wildcard: false,
    });
    server.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/ws")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    server.get("/", async () => ({
      name: "Project Helios",
      message:
        "The Project Helios API is running. The web interface has not been built yet — run `npm --workspace @helios/web run build` or use the development server.",
      api: "/api/health",
    }));
    server.setNotFoundHandler((request, reply) => {
      reply.code(404).send({ error: `Not found: ${request.url}` });
    });
  }

  server.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode >= 400 && !request.url.startsWith("/api/events")) {
      app.logger.debug("http response", {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
      });
    }
  });

  return server;
}
