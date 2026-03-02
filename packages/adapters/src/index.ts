import type { AdapterType, PlatformConfig, VoiceConfig } from "@voiceci/shared";
import { RUNNER_CALLBACK_HEADER } from "@voiceci/shared";
import type { AudioChannel } from "./audio-channel.js";
import { WsAudioChannel } from "./ws-audio-channel.js";
import { WebRtcAudioChannel } from "./webrtc-audio-channel.js";
import { SipAudioChannel } from "./sip-audio-channel.js";
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

export interface AudioChannelConfig {
  adapter: AdapterType;
  agentUrl?: string;
  targetPhoneNumber?: string;
  voice?: VoiceConfig;
  platform?: PlatformConfig;
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
      // Pass runner auth header for relay connections
      const headers: Record<string, string> = {};
      if (wsUrl.includes("/relay/connect")) {
        const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
        if (secret) headers[RUNNER_CALLBACK_HEADER] = secret;
      }
      return new WsAudioChannel({ wsUrl, headers });
    }

    case "webrtc": {
      const webrtc = config.voice?.webrtc;
      const livekitUrl =
        process.env[webrtc?.livekit_url_env ?? "LIVEKIT_URL"] ?? "";
      const apiKey =
        process.env[webrtc?.api_key_env ?? "LIVEKIT_API_KEY"] ?? "";
      const apiSecret =
        process.env[webrtc?.api_secret_env ?? "LIVEKIT_API_SECRET"] ?? "";
      const roomName =
        webrtc?.room ??
        `voiceci-${process.env["RUN_ID"] ?? crypto.randomUUID().slice(0, 8)}`;

      return new WebRtcAudioChannel({
        livekitUrl,
        apiKey,
        apiSecret,
        roomName,
      });
    }

    case "sip": {
      const telephony = config.voice?.telephony;
      const authId =
        process.env[telephony?.auth_id_env ?? "PLIVO_AUTH_ID"] ?? "";
      const authToken =
        process.env[telephony?.auth_token_env ?? "PLIVO_AUTH_TOKEN"] ?? "";
      const publicHost = process.env["RUNNER_PUBLIC_HOST"] ?? "localhost";

      if (!config.targetPhoneNumber) {
        throw new Error("SIP adapter requires targetPhoneNumber");
      }
      if (!telephony?.from_number) {
        throw new Error("SIP adapter requires voice.telephony.from_number");
      }

      return new SipAudioChannel({
        phoneNumber: config.targetPhoneNumber,
        fromNumber: telephony.from_number,
        authId,
        authToken,
        publicHost,
      });
    }

    case "vapi": {
      const apiKey = process.env[config.platform?.api_key_env ?? "VAPI_API_KEY"] ?? "";
      const assistantId = config.platform?.agent_id ?? "";
      if (!apiKey) throw new Error("Vapi adapter requires API key (set VAPI_API_KEY or platform.api_key_env)");
      if (!assistantId) throw new Error("Vapi adapter requires platform.agent_id");

      return new VapiAudioChannel({ apiKey, assistantId });
    }

    case "retell": {
      const apiKey = process.env[config.platform?.api_key_env ?? "RETELL_API_KEY"] ?? "";
      const agentId = config.platform?.agent_id ?? "";
      if (!apiKey) throw new Error("Retell adapter requires API key (set RETELL_API_KEY or platform.api_key_env)");
      if (!agentId) throw new Error("Retell adapter requires platform.agent_id");
      if (!config.targetPhoneNumber) throw new Error("Retell adapter requires targetPhoneNumber (the agent's phone number)");

      const retellTelephony = config.voice?.telephony;
      const retellAuthId = process.env[retellTelephony?.auth_id_env ?? "PLIVO_AUTH_ID"] ?? "";
      const retellAuthToken = process.env[retellTelephony?.auth_token_env ?? "PLIVO_AUTH_TOKEN"] ?? "";
      const retellPublicHost = process.env["RUNNER_PUBLIC_HOST"] ?? "localhost";
      if (!retellTelephony?.from_number) throw new Error("Retell adapter requires voice.telephony.from_number");

      return new RetellAudioChannel({
        apiKey,
        agentId,
        sip: {
          phoneNumber: config.targetPhoneNumber,
          fromNumber: retellTelephony.from_number,
          authId: retellAuthId,
          authToken: retellAuthToken,
          publicHost: retellPublicHost,
        },
      });
    }

    case "elevenlabs": {
      const apiKey = process.env[config.platform?.api_key_env ?? "ELEVENLABS_API_KEY"] ?? "";
      const agentId = config.platform?.agent_id ?? "";
      if (!apiKey) throw new Error("ElevenLabs adapter requires API key (set ELEVENLABS_API_KEY or platform.api_key_env)");
      if (!agentId) throw new Error("ElevenLabs adapter requires platform.agent_id");

      return new ElevenLabsAudioChannel({ apiKey, agentId });
    }

    case "bland": {
      const apiKey = process.env[config.platform?.api_key_env ?? "BLAND_API_KEY"] ?? "";
      if (!apiKey) throw new Error("Bland adapter requires API key (set BLAND_API_KEY or platform.api_key_env)");
      if (!config.targetPhoneNumber) throw new Error("Bland adapter requires targetPhoneNumber (the agent's phone number)");

      const blandTelephony = config.voice?.telephony;
      const blandAuthId = process.env[blandTelephony?.auth_id_env ?? "PLIVO_AUTH_ID"] ?? "";
      const blandAuthToken = process.env[blandTelephony?.auth_token_env ?? "PLIVO_AUTH_TOKEN"] ?? "";
      const blandPublicHost = process.env["RUNNER_PUBLIC_HOST"] ?? "localhost";
      if (!blandTelephony?.from_number) throw new Error("Bland adapter requires voice.telephony.from_number");

      return new BlandAudioChannel({
        apiKey,
        phoneNumber: config.targetPhoneNumber,
        sip: {
          phoneNumber: config.targetPhoneNumber,
          fromNumber: blandTelephony.from_number,
          authId: blandAuthId,
          authToken: blandAuthToken,
          publicHost: blandPublicHost,
        },
      });
    }

    default:
      throw new Error(`Unknown adapter type: ${config.adapter}`);
  }
}
