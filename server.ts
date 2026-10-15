import { createServer } from "node:http";
import { config } from "dotenv";
import next from "next";
import { Server } from "socket.io";

config({ path: ".env.local" });

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    handle(req, res);
  });
  new Server(httpServer, { path: "/socket.io" });
  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
