/**
 * VentServer — HTTP + WebSocket server that speaks the websocket protocol.
 *
 * - GET /health → { status: "ok" } (runner's waitForHealth() needs this)
 * - WS upgrades at root path → VentConnection per connection
 * - Binary frames = PCM 16-bit 24kHz mono
 * - Text frames = JSON tool call events
 */

import http from "node:http";
import { WebSocketServer } from "ws";
import type { VentServerConfig } from "./types.js";
import { VentConnection } from "./connection.js";

export class VentServer {
  private config: Required<Pick<VentServerConfig, "port" | "healthPath">> &
    VentServerConfig;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;

  constructor(config: VentServerConfig) {
    this.config = {
      port: 3001,
      healthPath: "/health",
      ...config,
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === this.config.healthPath) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on("connection", (ws) => {
        new VentConnection(ws, this.config.onAudio);
      });

      this.server.listen(this.config.port, () => {
        console.log(
          `[vent-sdk] listening on port ${this.config.port} (health: ${this.config.healthPath})`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }
}
