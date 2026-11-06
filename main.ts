import { createHeliosApp } from "@helios/core";
import { createServer } from "./server";

async function main(): Promise<void> {
  const app = createHeliosApp();
  const server = await createServer(app);
  const host = app.config.server.host;
  const port = app.config.server.port;
  await server.listen({ host, port });
  app.logger.info("project helios server listening", { url: `http://${host}:${port}`, home: app.paths.home });

  const shutdown = async (signal: string) => {
    app.logger.info("shutting down", { signal });
    try {
      await server.close();
    } finally {
      await app.shutdown();
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
