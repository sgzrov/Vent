export interface RelayClientConfig {
  apiUrl: string;
  runId: string;
  relayToken: string;
  agentPort: number;
  healthEndpoint: string;
}

interface DataConnection {
  relay: WebSocket;
  local: WebSocket;
  connId: string;
}

type RelayEventHandler = (...args: unknown[]) => void;

export class RelayClient {
  private controlWs: WebSocket | null = null;
  private dataConnections = new Map<string, DataConnection>();
  private config: RelayClientConfig;
  private closed = false;
  private handlers = new Map<string, RelayEventHandler[]>();
  private _agentEnv: Record<string, string> = {};

  constructor(config: RelayClientConfig) {
    this.config = config;
  }

  /** Env vars received from VoiceCI server to inject into the agent process. */
  get agentEnv(): Record<string, string> {
    return this._agentEnv;
  }

  on(event: string, handler: RelayEventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  async connect(): Promise<void> {
    const wsBase = this.config.apiUrl.replace(/^http/, "ws");
    const controlUrl = `${wsBase}/relay/control?run_id=${this.config.runId}&token=${this.config.relayToken}`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(controlUrl);
      let configReceived = false;

      ws.addEventListener("open", () => {
        this.controlWs = ws;
        this.setupControlHandlers(ws);
        this.emit("connected");
      });

      // Wait for the config message (sent immediately after auth) before resolving.
      // This ensures agentEnv is populated before the caller spawns the agent.
      this.on("config_received", () => {
        configReceived = true;
        resolve();
      });

      // Fallback: resolve after 3s even if no config arrives (backwards compat)
      setTimeout(() => {
        if (!configReceived && this.controlWs) resolve();
      }, 3_000);

      ws.addEventListener("error", (ev) => {
        if (!this.controlWs) {
          reject(new Error(`Failed to connect to relay: ${(ev as ErrorEvent).message ?? "connection error"}`));
        }
      });
    });
  }

  async activate(): Promise<void> {
    const activateUrl = `${this.config.apiUrl}/internal/runs/${this.config.runId}/activate`;
    const response = await fetch(activateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relay_token: this.config.relayToken }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Activation failed (${response.status}): ${text}`);
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;

    for (const [connId, conn] of this.dataConnections) {
      conn.relay.close();
      conn.local.close();
      this.dataConnections.delete(connId);
    }

    if (this.controlWs) {
      this.controlWs.close();
      this.controlWs = null;
    }
  }

  private setupControlHandlers(ws: WebSocket): void {
    ws.addEventListener("message", (event) => {
      try {
        const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        const msg = JSON.parse(data) as { type: string; conn_id?: string; env?: Record<string, string> };

        if (msg.type === "config" && msg.env) {
          this._agentEnv = msg.env;
          this.emit("config_received");
        } else if (msg.type === "new_connection" && msg.conn_id) {
          this.handleNewConnection(msg.conn_id);
        } else if (msg.type === "run_complete") {
          this.emit("run_complete");
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.addEventListener("close", () => {
      this.controlWs = null;
      if (!this.closed) {
        this.emit("disconnected");
      }
    });

    ws.addEventListener("error", (ev) => {
      this.emit("error", new Error((ev as ErrorEvent).message ?? "WebSocket error"));
    });
  }

  private async handleNewConnection(connId: string): Promise<void> {
    const agentUrl = `ws://localhost:${this.config.agentPort}`;
    const wsBase = this.config.apiUrl.replace(/^http/, "ws");
    const dataUrl = `${wsBase}/relay/data?run_id=${this.config.runId}&conn_id=${connId}&token=${this.config.relayToken}`;

    try {
      const [localWs, relayWs] = await Promise.all([
        this.openWebSocket(agentUrl),
        this.openWebSocket(dataUrl),
      ]);

      // Bidirectional forwarding
      localWs.addEventListener("message", (event) => {
        if (relayWs.readyState === WebSocket.OPEN) {
          relayWs.send(event.data);
        }
      });

      relayWs.addEventListener("message", (event) => {
        if (localWs.readyState === WebSocket.OPEN) {
          localWs.send(event.data);
        }
      });

      const cleanup = () => {
        if (localWs.readyState !== WebSocket.CLOSED) localWs.close();
        if (relayWs.readyState !== WebSocket.CLOSED) relayWs.close();
        this.dataConnections.delete(connId);
      };

      localWs.addEventListener("close", cleanup);
      relayWs.addEventListener("close", cleanup);
      localWs.addEventListener("error", cleanup);
      relayWs.addEventListener("error", cleanup);

      this.dataConnections.set(connId, { relay: relayWs, local: localWs, connId });
    } catch (err) {
      console.error(`[relay] Failed to establish connection ${connId}:`, err);
    }
  }

  private openWebSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("open", () => resolve(ws));
      ws.addEventListener("error", (ev) => reject(new Error((ev as ErrorEvent).message ?? `WS connect failed: ${url}`)));
    });
  }
}
