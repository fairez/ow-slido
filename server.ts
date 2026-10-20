import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { config, parse } from "dotenv";
import next from "next";
import { startSubscriptionSweep } from "./lib/billing/expire";
import { rebuildLeaderboard } from "./lib/leaderboard";
import { attachSocketServer } from "./lib/realtime/socket-server";
import { startRetentionSweep } from "./lib/retention";
import { startWorkspaceExportSweep } from "./lib/workspace-export";

const dev = process.env.NODE_ENV !== "production";

// In dev, .env.local wins over variables inherited from the shell, so a stray OPENAI_API_KEY in a shell
// profile cannot silently replace the project's key. In production the real environment wins, so hosting
// settings are never overridden by a local file.
const ENV_FILE = ".env.local";
const fileEnv = existsSync(ENV_FILE) ? parse(readFileSync(ENV_FILE)) : {};
const overridden = dev ? Object.keys(fileEnv).filter((k) => process.env[k] !== undefined && process.env[k] !== fileEnv[k]) : [];
config({ path: ENV_FILE, override: dev });
if (overridden.length > 0) console.log(`> ${ENV_FILE} replaced shell values for: ${overridden.join(", ")}`);

const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const httpServer = createServer((req, res) => {
    handle(req, res);
  });
  attachSocketServer(httpServer);
  startSubscriptionSweep();
  startRetentionSweep();
  startWorkspaceExportSweep();
  const restored = await rebuildLeaderboard();
  console.log(`> Leaderboard restored (${restored} scores)`);
  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
