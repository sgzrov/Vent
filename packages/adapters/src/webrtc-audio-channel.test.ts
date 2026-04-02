import test from "node:test";
import assert from "node:assert/strict";
import { DisconnectReason } from "@livekit/rtc-node";
import { WebRtcAudioChannel } from "./webrtc-audio-channel.js";

function makeChannel(): WebRtcAudioChannel {
  return new WebRtcAudioChannel({
    livekitUrl: "wss://example.livekit.test",
    apiKey: "test-key",
    apiSecret: "test-secret",
    roomName: "test-room",
  });
}

test("LiveKit adapter emits platformSpeechStart only on speaking transitions", () => {
  const channel = makeChannel();
  const speakingEvents: number[] = [];

  channel.on("platformSpeechStart", () => speakingEvents.push(Date.now()));

  (channel as any).currentTurnIndex = 0;
  (channel as any).turnTimings = [{}];

  (channel as any).handleAgentStateChange("speaking", 100);
  (channel as any).handleAgentStateChange("speaking", 150);
  (channel as any).handleAgentStateChange("listening", 200);
  (channel as any).handleAgentStateChange("speaking", 250);

  assert.equal(speakingEvents.length, 2);
  assert.equal((channel as any).turnTimings[0].speakingAt, 100);
  assert.equal((channel as any).turnTimings[0].listeningAt, 200);
});

test("LiveKit adapter emits platformEndOfTurn for opening speech with no active turn", () => {
  const channel = makeChannel();
  let endEvents = 0;

  channel.on("platformEndOfTurn", () => { endEvents += 1; });

  (channel as any).handleAgentStateChange("speaking", 100);
  (channel as any).handleAgentStateChange("listening", 200);

  assert.equal(endEvents, 1);
});

test("LiveKit adapter emits disconnected and marks the channel disconnected", () => {
  const channel = makeChannel();
  let disconnectEvents = 0;

  channel.on("disconnected", () => { disconnectEvents += 1; });
  (channel as any).room = {};

  (channel as any).handleRoomDisconnected(DisconnectReason.CLIENT_INITIATED);

  assert.equal(disconnectEvents, 1);
  assert.equal(channel.connected, false);
  assert.equal((channel as any).disconnectReasonStr, "CLIENT_INITIATED");
  assert.ok((channel as any).disconnectTimestamp > 0);
});
