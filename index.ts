import "dotenv/config";
import { createServer } from "node:http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initializeRealtime } from "./realtime/socket.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided. " +
      "Copy artifacts/api-server/.env.example to .env and fill it in.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);
initializeRealtime(httpServer);

httpServer.once("error", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
});

httpServer.listen({ port, host: "0.0.0.0" }, () => {
  logger.info({ port, host: "0.0.0.0" }, "Server listening");
});
