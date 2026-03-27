import type { AdapterType, PlatformConfig, BlandPlatformConfig, LiveKitPlatformConfig, VapiPlatformConfig } from "@vent/shared";
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

/** Build Vapi assistantOverrides from platform config fields */
function buildVapiOverrides(p: VapiPlatformConfig): Record<string, unknown> | undefined {
  const overrides: Record<string, unknown> = {};

  if (p.first_message != null) overrides.firstMessage = p.first_message;
  if (p.first_message_mode != null) overrides.firstMessageMode = p.first_message_mode;
  if (p.voice != null) overrides.voice = p.voice;
  if (p.end_call_message != null) overrides.endCallMessage = p.end_call_message;
  if (p.end_call_phrases != null) overrides.endCallPhrases = p.end_call_phrases;
  if (p.stop_speaking_plan != null) overrides.stopSpeakingPlan = p.stop_speaking_plan;
  if (p.start_speaking_plan != null) overrides.startSpeakingPlan = p.start_speaking_plan;
  if (p.silence_timeout_seconds != null) overrides.silenceTimeoutSeconds = p.silence_timeout_seconds;
  if (p.max_duration_seconds != null) overrides.maxDurationSeconds = p.max_duration_seconds;
  if (p.background_sound != null) overrides.backgroundSound = p.background_sound;
  if (p.background_denoising != null) overrides.backgroundDenoisingEnabled = p.background_denoising;
  if (p.model != null) overrides.model = p.model;
  if (p.transcriber != null) overrides.transcriber = p.transcriber;
  if (p.variable_values != null) overrides.variableValues = p.variable_values;
  if (p.metadata != null) overrides.metadata = p.metadata;
  if (p.hipaa_enabled != null) overrides.compliancePlan = { hipaaEnabled: p.hipaa_enabled };

  // Merge raw passthrough overrides (explicit fields take precedence)
  if (p.assistant_overrides != null) {
    return { ...p.assistant_overrides, ...overrides };
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
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
      const p = config.platform as LiveKitPlatformConfig | undefined;
      const apiKey = p?.api_key || process.env[p?.api_key_env ?? "LIVEKIT_API_KEY"] || "";
      const apiSecret = p?.api_secret || process.env["LIVEKIT_API_SECRET"] || "";
      const livekitUrl = p?.livekit_url || process.env["LIVEKIT_URL"] || "";
      const agentName = p?.agent_name;

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
      const p = config.platform as VapiPlatformConfig | undefined;
      const apiKey = p?.api_key || process.env[p?.api_key_env ?? "VAPI_API_KEY"] || "";
      const assistantId = resolveAgentId(p, "VAPI_ASSISTANT_ID");
      if (!apiKey) throw new Error("Vapi adapter requires API key (set VAPI_API_KEY or platform.api_key_env)");
      if (!assistantId) throw new Error("Vapi adapter requires VAPI_ASSISTANT_ID env or platform.agent_id");

      return new VapiAudioChannel({
        apiKey,
        assistantId,
        assistantOverrides: p ? buildVapiOverrides(p) : undefined,
      });
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
      const p = config.platform as BlandPlatformConfig | undefined;
      const apiKey = p?.api_key || process.env[p?.api_key_env ?? "BLAND_API_KEY"] || "";
      const agentId = resolveAgentId(p, "BLAND_PATHWAY_ID") || undefined;
      if (!apiKey) throw new Error("Bland adapter requires API key (set BLAND_API_KEY or platform.api_key_env)");
      if (!agentId && !p?.task) throw new Error("Bland adapter requires BLAND_PATHWAY_ID env, platform.agent_id, or platform.task (prompt)");

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
