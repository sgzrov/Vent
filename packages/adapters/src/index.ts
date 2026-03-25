import type { AdapterType, PlatformConfig } from "@vent/shared";
import { RUNNER_CALLBACK_HEADER } from "@vent/shared";
import type { AudioChannel } from "./audio-channel.js";
import { WsAudioChannel } from "./ws-audio-channel.js";
import { WebRtcAudioChannel } from "./webrtc-audio-channel.js";
import { SipAudioChannel, type SipAudioChannelConfig } from "./sip-audio-channel.js";
import { VapiAudioChannel } from "./vapi-audio-channel.js";
import { ElevenLabsAudioChannel } from "./elevenlabs-audio-channel.js";
import { RetellAudioChannel } from "./retell-audio-channel.js";
import { BlandAudioChannel } from "./bland-audio-channel.js";

export type { AudioChannel, AudioChannelEvents } from "./audio-channel.js";
export { BaseAudioChannel } from "./audio-channel.js";
export { WsAudioChannel } from "./ws-audio-channel.js";
export { WebRtcAudioChannel } from "./webrtc-audio-channel.js";
export { SipAudioChannel } from "./sip-audio-channel.js";
export { VapiAudioChannel } from "./vapi-audio-channel.js";
export type { VapiAssistantConfig } from "./vapi-audio-channel.js";
export { RetellAudioChannel } from "./retell-audio-channel.js";
export { ElevenLabsAudioChannel } from "./elevenlabs-audio-channel.js";
export { BlandAudioChannel } from "./bland-audio-channel.js";
export { SharedSipServer } from "./shared-sip-server.js";

export interface AudioChannelConfig {
  adapter: AdapterType;
  agentUrl?: string;
  targetPhoneNumber?: string;
  platform?: PlatformConfig;
  relayHeaders?: Record<string, string>;
}

/** SIP server port config from environment. On Fly.io, use a fixed port behind the reverse proxy. */
function sipPortConfig(): { port?: number; publicPort?: number | null } {
  const listenPort = parseInt(process.env["RUNNER_LISTEN_PORT"] ?? "0", 10) || undefined;
  return listenPort ? { port: listenPort, publicPort: null } : {};
}

/** Resolve agent_id: direct value → custom env var → default env var for provider */
function resolveAgentId(platform: PlatformConfig | undefined, defaultEnv: string): string {
  return platform?.agent_id
    || process.env[platform?.agent_id_env as string ?? defaultEnv]
    || "";
}

export function createAudioChannel(config: AudioChannelConfig): AudioChannel {
  const agentUrl = config.agentUrl ?? "http://localhost:3001";

  switch (config.adapter) {
    case "websocket": {
      let wsUrl = agentUrl.replace(/^http/, "ws");
      // When connecting through relay, append a unique conn_id per test connection
      if (wsUrl.includes("/relay/connect")) {
        const connId = crypto.randomUUID();
        wsUrl += (wsUrl.includes("?") ? "&" : "?") + `conn_id=${connId}`;
      }
      // Pass runner auth header + Fly routing header for relay connections
      const headers: Record<string, string> = {};
      if (wsUrl.includes("/relay/connect")) {
        const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
        if (secret) headers[RUNNER_CALLBACK_HEADER] = secret;
        if (config.relayHeaders) Object.assign(headers, config.relayHeaders);
      }
      return new WsAudioChannel({ wsUrl, headers });
    }

    case "webrtc":
    case "livekit": {
      const p = config.platform;
      const apiKey = (p?.api_key as string) || process.env[p?.api_key_env ?? "LIVEKIT_API_KEY"] || "";
      const apiSecret = (p?.api_secret as string) || process.env["LIVEKIT_API_SECRET"] || "";
      const livekitUrl = (p?.livekit_url as string) || process.env["LIVEKIT_URL"] || "";
      const agentName = p?.agent_name as string | undefined;

      if (!livekitUrl) throw new Error("LiveKit adapter requires LIVEKIT_URL env or platform.livekit_url");
      if (!apiKey) throw new Error("LiveKit adapter requires API key (set LIVEKIT_API_KEY or platform.api_key_env)");
      if (!apiSecret) throw new Error("LiveKit adapter requires LIVEKIT_API_SECRET env or platform.api_secret");

      const roomName = `vent-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
      return new WebRtcAudioChannel({
        livekitUrl,
        apiKey,
        apiSecret,
        roomName,
        agentName,
      });
    }

    case "sip": {
      const accountSid = process.env["TWILIO_ACCOUNT_SID"] ?? "";
      const authToken = process.env["TWILIO_AUTH_TOKEN"] ?? "";
      const fromNumber = process.env["TWILIO_FROM_NUMBER"] ?? "";
      const publicHost = process.env["RUNNER_PUBLIC_HOST"] ?? "localhost";

      if (!config.targetPhoneNumber) {
        throw new Error("SIP adapter requires targetPhoneNumber");
      }
      if (!fromNumber) {
        throw new Error("SIP adapter requires TWILIO_FROM_NUMBER env var");
      }

      return new SipAudioChannel({
        phoneNumber: config.targetPhoneNumber,
        fromNumber,
        accountSid,
        authToken,
        publicHost,
        ...sipPortConfig(),
      });
    }

    case "vapi": {
      const apiKey = config.platform?.api_key || process.env[config.platform?.api_key_env ?? "VAPI_API_KEY"] || "";
      const assistantId = resolveAgentId(config.platform, "VAPI_ASSISTANT_ID");
      if (!apiKey) throw new Error("Vapi adapter requires API key (set VAPI_API_KEY or platform.api_key_env)");
      if (!assistantId) throw new Error("Vapi adapter requires VAPI_ASSISTANT_ID env or platform.agent_id");

      return new VapiAudioChannel({ apiKey, assistantId });
    }

    case "retell": {
      const apiKey = config.platform?.api_key || process.env[config.platform?.api_key_env ?? "RETELL_API_KEY"] || "";
      const agentId = resolveAgentId(config.platform, "RETELL_AGENT_ID");
      if (!apiKey) throw new Error("Retell adapter requires API key (set RETELL_API_KEY or platform.api_key_env)");
      if (!agentId) throw new Error("Retell adapter requires RETELL_AGENT_ID env or platform.agent_id");
      if (!config.targetPhoneNumber) throw new Error("Retell adapter requires targetPhoneNumber (the agent's phone number)");

      const retellAccountSid = process.env["TWILIO_ACCOUNT_SID"] ?? "";
      const retellAuthToken = process.env["TWILIO_AUTH_TOKEN"] ?? "";
      const retellFromNumber = process.env["TWILIO_FROM_NUMBER"] ?? "";
      const retellPublicHost = process.env["RUNNER_PUBLIC_HOST"] ?? "localhost";
      if (!retellFromNumber) throw new Error("Retell adapter requires TWILIO_FROM_NUMBER env var");

      return new RetellAudioChannel({
        apiKey,
        agentId,
        sip: {
          phoneNumber: config.targetPhoneNumber,
          fromNumber: retellFromNumber,
          accountSid: retellAccountSid,
          authToken: retellAuthToken,
          publicHost: retellPublicHost,
          ...sipPortConfig(),
        },
      });
    }

    case "elevenlabs": {
      const apiKey = config.platform?.api_key || process.env[config.platform?.api_key_env ?? "ELEVENLABS_API_KEY"] || "";
      const agentId = resolveAgentId(config.platform, "ELEVENLABS_AGENT_ID");
      if (!apiKey) throw new Error("ElevenLabs adapter requires API key (set ELEVENLABS_API_KEY or platform.api_key_env)");
      if (!agentId) throw new Error("ElevenLabs adapter requires ELEVENLABS_AGENT_ID env or platform.agent_id");

      return new ElevenLabsAudioChannel({ apiKey, agentId });
    }

    case "bland": {
      const p = config.platform;
      const apiKey = p?.api_key || process.env[p?.api_key_env ?? "BLAND_API_KEY"] || "";
      const agentId = resolveAgentId(p, "BLAND_PATHWAY_ID") || undefined;
      const task = p?.task as string | undefined;
      if (!apiKey) throw new Error("Bland adapter requires API key (set BLAND_API_KEY or platform.api_key_env)");
      if (!agentId && !task) throw new Error("Bland adapter requires BLAND_PATHWAY_ID env, platform.agent_id, or platform.task (prompt)");

      const blandFromNumber = process.env["TWILIO_FROM_NUMBER"] ?? "";
      const blandAccountSid = process.env["TWILIO_ACCOUNT_SID"] ?? "";
      const blandAuthToken = process.env["TWILIO_AUTH_TOKEN"] ?? "";
      const blandPublicHost = process.env["RUNNER_PUBLIC_HOST"] ?? "";
      if (!blandFromNumber || !blandAccountSid || !blandAuthToken || !blandPublicHost) {
        throw new Error("Bland adapter requires Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER) and RUNNER_PUBLIC_HOST");
      }

      return new BlandAudioChannel({
        apiKey,
        agentId,
        server: {
          accountSid: blandAccountSid,
          authToken: blandAuthToken,
          fromNumber: blandFromNumber,
          publicHost: blandPublicHost,
          ...sipPortConfig(),
        },
        callOptions: {
          task,
          tools: p?.tools as unknown[] | undefined,
          voice: p?.voice as string | undefined,
          model: p?.model as string | undefined,
          first_sentence: p?.first_sentence as string | undefined,
          wait_for_greeting: p?.wait_for_greeting as boolean | undefined,
          max_duration: p?.max_duration as number | undefined,
          temperature: p?.temperature as number | undefined,
          language: p?.language as string | undefined,
          interruption_threshold: p?.interruption_threshold as number | undefined,
        },
      });
    }

    default:
      throw new Error(`Unknown adapter type: ${config.adapter}`);
  }
}
