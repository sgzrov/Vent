/**
 * Shared Webhook Server for Bland WS adapter callbacks.
 *
 * Singleton HTTP server that multiple BlandWsAudioChannels share.
 * Lifecycle is ref-counted: first acquireWebhookServer() starts the server,
 * handlers are registered/unregistered per channel.
 */

import http from "node:http";

const BLAND_WEBHOOK_PREFIX = "/bland-ws-webhook/";

export interface WebhookServerConfig {
  publicHost: string;
  /** Fixed port for the HTTP server (default: 0 = random). */
  port?: number;
  /** Port in public URLs. `null` = omit (behind reverse proxy on 443). */
  publicPort?: number | null;
}

export class WebhookServer {
  private static instance: WebhookServer | null = null;

  private config: WebhookServerConfig;
  private server: http.Server | null = null;
  private port = 0;
  private started = false;
  private refCount = 0;

  private handlers = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>();

  private constructor(config: WebhookServerConfig) {
    this.config = config;
  }

  /**
   * Get or create the singleton server. Increments ref count.
   * First call starts the HTTP server.
   */
  static async acquire(config: WebhookServerConfig): Promise<WebhookServer> {
    if (!WebhookServer.instance) {
      WebhookServer.instance = new WebhookServer(config);
    }
    const server = WebhookServer.instance;
    server.refCount++;

    if (!server.started) {
      await server.startServer();
      server.started = true;
      console.log(`[webhook-server] Started on port ${server.port}`);
    }

    return server;
  }

  /**
   * Start the HTTP server at worker boot (before any channels acquire).
   * Ensures the port is bound early for reverse proxies (e.g. Fly.io).
   */
  static async startPersistentServer(config: WebhookServerConfig): Promise<void> {
    if (!WebhookServer.instance) {
      WebhookServer.instance = new WebhookServer(config);
    }
    const server = WebhookServer.instance;
    if (!server.started) {
      await server.startServer();
      server.started = true;
      console.log(`[webhook-server] Persistent server started on port ${server.port}`);
    }
  }

  /** Public base URL for webhook callbacks. */
  get publicBaseUrl(): string {
    const pp = this.config.publicPort;
    if (pp === null) return `https://${this.config.publicHost}`;
    if (pp !== undefined) return `https://${this.config.publicHost}:${pp}`;
    return `https://${this.config.publicHost}:${this.port}`;
  }

  /** Register a webhook handler for a path prefix (e.g. "/bland-ws-webhook/{channelId}"). */
  registerHandler(channelId: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): void {
    this.handlers.set(channelId, handler);
    console.log(`[webhook-server] Handler registered for ${channelId}`);
  }

  /** Unregister a webhook handler. */
  unregisterHandler(channelId: string): void {
    this.handlers.delete(channelId);
    console.log(`[webhook-server] Handler unregistered for ${channelId}`);
  }

  /** Release a reference. Server stays running (for persistent use). */
  async release(): Promise<void> {
    this.refCount--;
    console.log(`[webhook-server] Released (refCount: ${this.refCount})`);
  }

  // ── Setup ──────────────────────────────────────────────────

  private startServer(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.config.port ?? 0, "0.0.0.0", () => {
        const addr = this.server!.address();
        if (addr && typeof addr !== "string") {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  // ── HTTP Request Handler ───────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    const blandWebhookRoute = this.parseBlandWebhookPath(pathname);
    if (blandWebhookRoute) {
      if (this.replayToTargetMachineIfNeeded(req, res, blandWebhookRoute.machineId)) {
        return;
      }

      const { channelId } = blandWebhookRoute;
      const handler = this.handlers.get(channelId);
      if (handler) {
        handler(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private parseBlandWebhookPath(pathname: string): { machineId: string | null; channelId: string } | null {
    if (!pathname.startsWith(BLAND_WEBHOOK_PREFIX)) {
      return null;
    }

    const parts = pathname
      .slice(BLAND_WEBHOOK_PREFIX.length)
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));

    if (parts.length === 1) {
      return { machineId: null, channelId: parts[0] };
    }

    if (parts.length === 2) {
      return { machineId: parts[0], channelId: parts[1] };
    }

    return null;
  }

  private replayToTargetMachineIfNeeded(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetMachineId: string | null,
  ): boolean {
    const currentMachineId = process.env["FLY_MACHINE_ID"];
    if (!targetMachineId || !currentMachineId || targetMachineId === currentMachineId) {
      return false;
    }

    const replaySource = this.readHeader(req.headers["fly-replay-src"]);
    if (replaySource.includes(`instance=${currentMachineId}`)) {
      console.error(
        `[webhook-server] Replay loop detected for target=${targetMachineId} current=${currentMachineId}`,
      );
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("fly replay loop detected");
      return true;
    }

    console.log(`[webhook-server] Replaying Bland callback to machine ${targetMachineId}`);
    res.writeHead(307, {
      "Content-Type": "text/plain; charset=utf-8",
      "Fly-Replay": `instance=${targetMachineId};state=bland-webhook`,
    });
    res.end();
    return true;
  }

  private readHeader(value: string | string[] | undefined): string {
    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.join(",");
    }

    return "";
  }
}
