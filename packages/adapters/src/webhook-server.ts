/**
 * Shared Webhook Server for Bland WS adapter callbacks.
 *
 * Singleton HTTP server that multiple BlandWsAudioChannels share.
 * Lifecycle is ref-counted: first acquireWebhookServer() starts the server,
 * handlers are registered/unregistered per channel.
 */

import http from "node:http";

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

      this.server.listen(this.config.port ?? 0, () => {
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

    // Bland WS adapter webhook — /bland-ws-webhook/{channelId}
    if (pathname.startsWith("/bland-ws-webhook/")) {
      const channelId = pathname.slice("/bland-ws-webhook/".length);
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
}
