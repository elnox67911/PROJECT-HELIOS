import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { HeliosApp, RunEvent } from "@helios/core";
import { eventStreamPayload, HttpError } from "./http";

interface SseClient {
  res: ServerResponse;
  runId: string | null;
}

export function registerStreams(server: FastifyInstance, app: HeliosApp): WebSocketServer {
  const sseClients = new Set<SseClient>();
  const wss = new WebSocketServer({ server: server.server, path: "/ws" });
  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.res.write(": ping\n\n");
      } catch {
        sseClients.delete(client);
      }
    }
  }, 20_000);
  heartbeat.unref?.();

  const broadcast = (message: unknown) => {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  const unsubscribe = app.events.subscribe("*", (event) => {
    broadcast({ type: "event", event });
    for (const client of sseClients) {
      if (client.runId && client.runId !== event.runId) continue;
      try {
        client.res.write(eventStreamPayload(event));
      } catch {
        sseClients.delete(client);
      }
    }
  });

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "hello",
        at: new Date().toISOString(),
        activeRuns: app.runtime.activeRunIds(),
      }),
    );
    socket.on("error", () => {
      // connection-level errors are not fatal for the server
    });
  });

  server.addHook("onClose", async () => {
    unsubscribe();
    clearInterval(heartbeat);
    for (const client of sseClients) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    wss.close();
  });

  const openSse = (raw: ServerResponse, role: string) => {
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    raw.write(`retry: 3000\n: ${role} subscribed\n\n`);
    return raw;
  };

  server.get("/api/events/stream", async (request, reply) => {
    const query = request.query as { runId?: string };
    reply.hijack();
    const res = openSse(reply.raw, "activity");
    const client: SseClient = { res, runId: query.runId ?? null };
    sseClients.add(client);
    if (query.runId) {
      for (const event of app.store.listEvents(query.runId, 0, 200)) {
        res.write(eventStreamPayload(event));
      }
    } else {
      for (const event of app.store.listRecentEvents(50)) {
        res.write(eventStreamPayload(event));
      }
    }
    request.raw.on("close", () => {
      sseClients.delete(client);
    });
  });

  server.get("/api/runs/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = app.store.getRun(id);
    if (!run) throw new HttpError(404, `Run ${id} not found.`);
    const query = request.query as { after?: string };
    reply.hijack();
    const res = openSse(reply.raw, `run ${id}`);
    const client: SseClient = { res, runId: id };
    sseClients.add(client);
    const after = Number(query.after ?? 0);
    for (const event of app.store.listEvents(id, Number.isFinite(after) ? after : 0, 2_000)) {
      res.write(eventStreamPayload(event));
    }
    request.raw.on("close", () => {
      sseClients.delete(client);
    });
  });

  server.get("/api/events/history", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? 100)));
    return { events: app.store.listRecentEvents(limit) };
  });

  return wss;
}

export function publishSynthetic(app: HeliosApp, event: RunEvent): void {
  app.events.publish(event);
}
