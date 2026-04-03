/**
 * Shared SIP Server for concurrent Bland calls.
 *
 * Singleton HTTP+WebSocket server that multiple BlandAudioChannels share.
 * One TwiML app, one Twilio number config, many concurrent calls.
 *
 * Lifecycle is ref-counted: first acquire() starts the server, last release() tears it down.
 * WebSocket connections are dispatched to waiting channels via FIFO queue.
 */

import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import { randomBytes } from "node:crypto";
import Twilio from "twilio";

export interface SharedSipServerConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  publicHost: string;
  /** Fixed port for the HTTP server (default: 0 = random). */
  port?: number;
  /** Port in public URLs. `null` = omit (behind reverse proxy on 443). */
  publicPort?: number | null;
}

interface WaitingChannel {
  channelId: string;
  resolve: (result: { ws: WebSocket; streamSid: string; callSid: string }) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RegisteredChannel {
  channelId: string;
  webhookHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  toolCallToken: string;
  toolCallHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
}

interface TwilioStreamMessage {
  event: string;
  start?: { streamSid: string; callSid: string };
  media?: { payload: string };
}

export class SharedSipServer {
  private static instance: SharedSipServer | null = null;

  private config: SharedSipServerConfig;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private refCount = 0;

  private serverStarted = false;

  // Twilio state
  private twilio: ReturnType<typeof Twilio>;
  private appSid: string | null = null;
  private numberSid: string | null = null;
  private originalVoiceUrl: string | null = null;
  private twilioSetupPromise: Promise<void> | null = null;

  // FIFO dispatch queue
  private waitQueue: WaitingChannel[] = [];
  private channels = new Map<string, RegisteredChannel>();

  // Initiation mutex for rate limiting
  private initiationQueue: Array<() => void> = [];
  private initiationActive = false;
  private lastCallTime = 0;

  // Session nonce — prevents stale calls from killed runs being dispatched to new runs
  private sessionNonce: string = "";

  private constructor(config: SharedSipServerConfig) {
    this.config = config;
    this.twilio = Twilio(config.accountSid, config.authToken);
  }

  /**
   * Start the HTTP server early (call at worker boot).
   * This ensures Fly.io's proxy sees a listener on port 8443.
   * Twilio setup happens lazily on first acquire().
   */
  static async startPersistentServer(config: SharedSipServerConfig): Promise<void> {
    if (!SharedSipServer.instance) {
      SharedSipServer.instance = new SharedSipServer(config);
    }
    const server = SharedSipServer.instance;
    if (!server.serverStarted) {
      await server.startServer();
      server.serverStarted = true;
      console.log(`[shared-sip] Persistent server started on port ${server.port}`);
    }
  }

  /**
   * Get or create the singleton server. Increments ref count.
   * First call configures Twilio (server must already be started).
   */
  static async acquire(config: SharedSipServerConfig): Promise<SharedSipServer> {
    if (!SharedSipServer.instance) {
      SharedSipServer.instance = new SharedSipServer(config);
    }
    const server = SharedSipServer.instance;
    server.refCount++;

    // Start HTTP server if not already persistent
    if (!server.serverStarted) {
      await server.startServer();
      server.serverStarted = true;
    }

    // Setup Twilio on first acquire
    if (!server.twilioSetupPromise) {
      server.twilioSetupPromise = server.setupTwilio();
    }
    await server.twilioSetupPromise;
    return server;
  }

  /**
   * Register a channel to receive the next incoming WebSocket connection.
   * Returns a promise that resolves when Bland's call arrives and the media stream connects.
   */
  registerChannel(opts: {
    channelId: string;
    webhookHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    toolCallToken: string;
    toolCallHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  }): Promise<{ ws: WebSocket; streamSid: string; callSid: string }> {
    // Register routes for this channel
    this.channels.set(opts.channelId, {
      channelId: opts.channelId,
      webhookHandler: opts.webhookHandler,
      toolCallToken: opts.toolCallToken,
      toolCallHandler: opts.toolCallHandler,
    });

    // Add to FIFO wait queue
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from queue on timeout
        const idx = this.waitQueue.findIndex((w) => w.channelId === opts.channelId);
        if (idx >= 0) this.waitQueue.splice(idx, 1);
        console.warn(`[shared-sip] Channel ${opts.channelId} timed out waiting for call (waitQueue: ${this.waitQueue.length} remaining)`);
        reject(new Error(`SharedSipServer: timeout waiting for Bland call (channel ${opts.channelId})`));
      }, 120_000); // 120s timeout (accounts for 10s rate limit gaps × queue depth)

      this.waitQueue.push({ channelId: opts.channelId, resolve, reject, timeout });
      console.log(`[shared-sip] Channel ${opts.channelId} registered (waitQueue position: ${this.waitQueue.length}, refCount: ${this.refCount})`);
    });
  }

  /**
   * Serialize call initiation. Enforces 1.5s gap between calls.
   * If Bland returns 429, caller should wait 10s and retry.
   * Returns a release function to call after the WebSocket connects.
   */
  async acquireInitiationLock(): Promise<() => void> {
    // Wait for our turn
    if (this.initiationActive) {
      await new Promise<void>((resolve) => {
        this.initiationQueue.push(resolve);
      });
    }
    this.initiationActive = true;

    // Enforce 10s gap between calls (Bland rate limits per-phone-number)
    const elapsed = Date.now() - this.lastCallTime;
    const GAP_MS = 10_000;
    if (elapsed < GAP_MS && this.lastCallTime > 0) {
      const waitMs = GAP_MS - elapsed;
      console.log(`[shared-sip] Rate limit: waiting ${Math.round(waitMs / 1000)}s before next call`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    this.lastCallTime = Date.now();

    return () => {
      this.initiationActive = false;
      const next = this.initiationQueue.shift();
      if (next) next();
    };
  }

  /** Public base URL for webhooks/TwiML. */
  get publicBaseUrl(): string {
    const pp = this.config.publicPort;
    if (pp === null) return `https://${this.config.publicHost}`;
    if (pp !== undefined) return `https://${this.config.publicHost}:${pp}`;
    return `https://${this.config.publicHost}:${this.port}`;
  }

  /** WSS base URL for Twilio Stream. */
  get wssBaseUrl(): string {
    const pp = this.config.publicPort;
    if (pp === null) return `wss://${this.config.publicHost}`;
    if (pp !== undefined) return `wss://${this.config.publicHost}:${pp}`;
    return `wss://${this.config.publicHost}:${this.port}`;
  }

  async completeCall(callSid: string | null | undefined): Promise<void> {
    if (!callSid) return;
    try {
      await this.twilio.calls(callSid).update({ status: "completed" });
    } catch {
      // Already ended or unavailable.
    }
  }

  /**
   * Unregister a channel and decrement ref count.
   * Tears down server when last channel releases.
   */
  async release(channelId: string): Promise<void> {
    this.channels.delete(channelId);

    // Remove from wait queue if still waiting
    const idx = this.waitQueue.findIndex((w) => w.channelId === channelId);
    if (idx >= 0) {
      clearTimeout(this.waitQueue[idx].timeout);
      this.waitQueue.splice(idx, 1);
    }

    this.refCount--;
    console.log(`[shared-sip] Channel ${channelId} released (refCount: ${this.refCount}, waitQueue: ${this.waitQueue.length})`);
    if (this.refCount <= 0) {
      await this.teardown();
    }
  }

  // ── Setup & Teardown ──────────────────────────────────────

  private startServer(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on("connection", (ws, req) => this.handleWebSocketConnection(ws, req));

      this.server.listen(this.config.port ?? 0, () => {
        const addr = this.server!.address();
        if (addr && typeof addr !== "string") {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  private async setupTwilio(): Promise<void> {
    // Generate session nonce — used to reject stale WebSocket connections from killed runs
    this.sessionNonce = randomBytes(8).toString("hex");

    // Create TwiML Application
    const app = await this.twilio.applications.create({
      friendlyName: `vent-shared-${Date.now()}`,
      voiceUrl: `${this.publicBaseUrl}/answer`,
      voiceMethod: "GET",
    });
    this.appSid = app.sid;

    // Find and configure our phone number
    const numbers = await this.twilio.incomingPhoneNumbers.list({
      phoneNumber: this.config.fromNumber,
    });
    if (!numbers.length) {
      throw new Error(`Twilio number ${this.config.fromNumber} not found in account`);
    }

    this.numberSid = numbers[0].sid;
    this.originalVoiceUrl = numbers[0].voiceUrl;

    await this.twilio.incomingPhoneNumbers(this.numberSid).update({
      voiceApplicationSid: this.appSid,
    });

    console.log(`[shared-sip] Twilio configured: TwiML app ${this.appSid}, number ${this.config.fromNumber}`);
  }

  private async teardown(): Promise<void> {
    console.log("[shared-sip] Tearing down Twilio config (server stays running)...");

    // Delete TwiML app
    if (this.appSid) {
      await this.twilio.applications(this.appSid).remove().catch(() => {});
      this.appSid = null;
    }

    // Restore original number config
    if (this.numberSid && this.originalVoiceUrl !== null) {
      await this.twilio
        .incomingPhoneNumbers(this.numberSid)
        .update({ voiceUrl: this.originalVoiceUrl })
        .catch(() => {});
      this.numberSid = null;
      this.originalVoiceUrl = null;
    }

    // Reset Twilio setup so next acquire() re-configures
    this.twilioSetupPromise = null;
    this.refCount = 0;
    this.lastCallTime = 0;

    // Keep HTTP server + WSS running for Fly.io proxy
    console.log("[shared-sip] Twilio teardown complete, server still listening on port " + this.port);
  }

  // ── HTTP Request Handler ──────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // TwiML answer — same for all calls
    if (pathname === "/answer") {
      const from = url.searchParams.get("From") ?? url.searchParams.get("Caller") ?? "unknown";
      console.log(`[shared-sip] /answer hit — waitQueue: ${this.waitQueue.length}, refCount: ${this.refCount}, from: ${from}`);

      // If no channels are waiting on this machine, replay to another Fly machine
      if (this.waitQueue.length === 0 && this.refCount === 0 && process.env["FLY_MACHINE_ID"]) {
        console.log("[shared-sip] No channels waiting on this machine, replaying to another instance");
        res.writeHead(200, { "fly-replay": "elsewhere=true" });
        res.end();
        return;
      }

      const wsUrl = `${this.wssBaseUrl}/stream?nonce=${this.sessionNonce}`;
      const twiml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<Response>",
        `  <Connect><Stream url="${wsUrl}"/></Connect>`,
        "</Response>",
      ].join("\n");
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(twiml);
      return;
    }

    // Bland webhook — /bland-webhook/{channelId}
    if (pathname.startsWith("/bland-webhook/")) {
      const channelId = pathname.slice("/bland-webhook/".length);
      const channel = this.channels.get(channelId);
      if (channel) {
        channel.webhookHandler(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
      return;
    }

    // Tool call — /tool-calls/{token}
    if (pathname.startsWith("/tool-calls/")) {
      const token = pathname.slice("/tool-calls/".length);
      // Find channel by token
      for (const ch of this.channels.values()) {
        if (ch.toolCallToken === token) {
          ch.toolCallHandler(req, res);
          return;
        }
      }
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  }

  // ── WebSocket Dispatch ────────────────────────────────────

  private handleWebSocketConnection(ws: WebSocket, req: http.IncomingMessage): void {
    console.log(`[shared-sip] WebSocket connected (waitQueue: ${this.waitQueue.length}, refCount: ${this.refCount})`);

    // Reject stale connections from killed runs by checking the session nonce
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const nonce = reqUrl.searchParams.get("nonce");
    if (nonce && nonce !== this.sessionNonce) {
      console.warn(`[shared-sip] Rejecting stale WebSocket (nonce ${nonce} !== ${this.sessionNonce})`);
      ws.close();
      return;
    }

    // Wait for Twilio's "start" event to get streamSid and callSid
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      let raw: string;
      if (Buffer.isBuffer(data)) {
        raw = data.toString();
      } else if (data instanceof ArrayBuffer) {
        raw = Buffer.from(new Uint8Array(data)).toString();
      } else {
        raw = Buffer.concat(data as Buffer[]).toString();
      }

      let msg: TwilioStreamMessage;
      try {
        msg = JSON.parse(raw) as TwilioStreamMessage;
      } catch {
        return;
      }

      if (msg.event === "start" && msg.start?.streamSid) {
        // Remove this one-shot listener
        ws.removeListener("message", onMessage);

        // Dispatch to first waiting channel
        const waiting = this.waitQueue.shift();
        if (waiting) {
          clearTimeout(waiting.timeout);
          console.log(`[shared-sip] Stream started: streamSid=${msg.start.streamSid}, callSid=${msg.start.callSid}, dispatched to channel ${waiting.channelId} (waitQueue remaining: ${this.waitQueue.length})`);
          waiting.resolve({
            ws,
            streamSid: msg.start.streamSid,
            callSid: msg.start.callSid,
          });
        } else {
          console.warn("[shared-sip] WebSocket connected but no channel waiting — closing");
          ws.close();
        }
      }
    };

    ws.on("message", onMessage);
  }
}
