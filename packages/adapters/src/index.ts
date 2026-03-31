import type { AdapterType, PlatformConfig, BlandPlatformConfig, LiveKitPlatformConfig, VapiPlatformConfig, RetellPlatformConfig, ElevenLabsPlatformConfig } from "@vent/shared";
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

    case "livekit": {
      const p = config.platform as LiveKitPlatformConfig | undefined;
      const apiKey = p?.livekit_api_key || process.env["LIVEKIT_API_KEY"] || "";
      const apiSecret = p?.livekit_api_secret || process.env["LIVEKIT_API_SECRET"] || "";
      const livekitUrl = p?.livekit_url || process.env["LIVEKIT_URL"] || "";
      const agentName = p?.livekit_agent_name;

      if (!livekitUrl) throw new Error("LiveKit adapter requires LIVEKIT_URL env or platform.livekit_url");
      if (!apiKey) throw new Error("LiveKit adapter requires LIVEKIT_API_KEY env or platform.livekit_api_key");
      if (!apiSecret) throw new Error("LiveKit adapter requires LIVEKIT_API_SECRET env or platform.livekit_api_secret");

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
      const p = config.platform as VapiPlatformConfig | undefined;
      const apiKey = p?.vapi_api_key || process.env["VAPI_API_KEY"] || "";
      const assistantId = p?.vapi_assistant_id || process.env["VAPI_ASSISTANT_ID"] || "";
      if (!apiKey) throw new Error("Vapi adapter requires vapi_api_key or VAPI_API_KEY env");
      if (!assistantId) throw new Error("Vapi adapter requires vapi_assistant_id or VAPI_ASSISTANT_ID env");

      return new VapiAudioChannel({ apiKey, assistantId });
    }

    case "retell": {
      const p = config.platform as RetellPlatformConfig | undefined;
      const apiKey = p?.retell_api_key || process.env["RETELL_API_KEY"] || "";
      const agentId = p?.retell_agent_id || process.env["RETELL_AGENT_ID"] || "";
      if (!apiKey) throw new Error("Retell adapter requires retell_api_key or RETELL_API_KEY env");
      if (!agentId) throw new Error("Retell adapter requires retell_agent_id or RETELL_AGENT_ID env");
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
      const p = config.platform as ElevenLabsPlatformConfig | undefined;
      const apiKey = p?.elevenlabs_api_key || process.env["ELEVENLABS_API_KEY"] || "";
      const agentId = p?.elevenlabs_agent_id || process.env["ELEVENLABS_AGENT_ID"] || "";
      if (!apiKey) throw new Error("ElevenLabs adapter requires elevenlabs_api_key or ELEVENLABS_API_KEY env");
      if (!agentId) throw new Error("ElevenLabs adapter requires elevenlabs_agent_id or ELEVENLABS_AGENT_ID env");

      return new ElevenLabsAudioChannel({ apiKey, agentId });
    }

    case "bland": {
      const p = config.platform as BlandPlatformConfig | undefined;
      const apiKey = p?.bland_api_key || process.env["BLAND_API_KEY"] || "";
      const pathwayId = p?.bland_pathway_id || process.env["BLAND_PATHWAY_ID"] || "";
      if (!apiKey) throw new Error("Bland adapter requires bland_api_key or BLAND_API_KEY env");
      if (!pathwayId && !p?.task) {
        throw new Error("Bland adapter requires bland_pathway_id or BLAND_PATHWAY_ID env, or platform.task");
      }

      const blandFromNumber = process.env["TWILIO_FROM_NUMBER"] ?? "";
      const blandAccountSid = process.env["TWILIO_ACCOUNT_SID"] ?? "";
      const blandAuthToken = process.env["TWILIO_AUTH_TOKEN"] ?? "";
      const blandPublicHost = process.env["RUNNER_PUBLIC_HOST"] ?? "";
      if (!blandFromNumber || !blandAccountSid || !blandAuthToken || !blandPublicHost) {
        throw new Error("Bland adapter requires Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER) and RUNNER_PUBLIC_HOST");
      }

      return new BlandAudioChannel({
        apiKey,
        agentId: pathwayId || undefined,
        server: {
          accountSid: blandAccountSid,
          authToken: blandAuthToken,
          fromNumber: blandFromNumber,
          publicHost: blandPublicHost,
          ...sipPortConfig(),
        },
        callOptions: {
          task: p?.task,
          tools: p?.tools,
          voice: p?.voice,
          model: p?.model,
          first_sentence: p?.first_sentence,
          wait_for_greeting: p?.wait_for_greeting,
          max_duration: p?.max_duration,
          temperature: p?.temperature,
          language: p?.language,
          interruption_threshold: p?.interruption_threshold,
          block_interruptions: p?.block_interruptions,
          noise_cancellation: p?.noise_cancellation,
          background_track: p?.background_track,
          keywords: p?.keywords,
          request_data: p?.request_data,
          pronunciation_guide: p?.pronunciation_guide,
          start_node_id: p?.start_node_id,
          pathway_version: p?.pathway_version,
        },
      });
    }

    default:
      throw new Error(`Unknown adapter type: ${config.adapter}`);
  }
}
