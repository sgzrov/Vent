import type { AdapterType, PlatformConfig } from "@voiceci/shared";
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
      const livekitUrl = process.env["LIVEKIT_URL"] ?? "";
      const apiKey = process.env["LIVEKIT_API_KEY"] ?? "";
      const apiSecret = process.env["LIVEKIT_API_SECRET"] ?? "";
      const roomName = `voiceci-${process.env["RUN_ID"] ?? crypto.randomUUID().slice(0, 8)}`;

      return new WebRtcAudioChannel({
        livekitUrl,
        apiKey,
        apiSecret,
        roomName,
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

      const blandAccountSid = process.env["TWILIO_ACCOUNT_SID"] ?? "";
      const blandAuthToken = process.env["TWILIO_AUTH_TOKEN"] ?? "";
      const blandFromNumber = process.env["TWILIO_FROM_NUMBER"] ?? "";
      const blandPublicHost = process.env["RUNNER_PUBLIC_HOST"] ?? "localhost";
      if (!blandFromNumber) throw new Error("Bland adapter requires TWILIO_FROM_NUMBER env var");

      return new BlandAudioChannel({
        apiKey,
        phoneNumber: config.targetPhoneNumber,
        sip: {
          phoneNumber: config.targetPhoneNumber,
          fromNumber: blandFromNumber,
          accountSid: blandAccountSid,
          authToken: blandAuthToken,
          publicHost: blandPublicHost,
        },
      });
    }

    default:
      throw new Error(`Unknown adapter type: ${config.adapter}`);
  }
}
