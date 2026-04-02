import test from "node:test";
import assert from "node:assert/strict";
import { BaseAudioChannel } from "@vent/adapters";
import type { VoiceActivityDetector, VADState } from "@vent/voice";
import { collectUntilEndOfTurn } from "./helpers.js";

class FakeAudioChannel extends BaseAudioChannel {
  hasPlatformEndOfTurn = true;
  private isConnected = true;

  get connected(): boolean {
    return this.isConnected;
  }

  async connect(): Promise<void> {}

  sendAudio(_pcm: Buffer): void {}

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.emit("disconnected");
  }

  markDisconnected(): void {
    this.isConnected = false;
    this.emit("disconnected");
  }
}

function makeFakeVAD(states: VADState[]): VoiceActivityDetector {
  let index = 0;
  return {
    silenceThresholdMs: 0,
    async init() {},
    reset() {},
    destroy() {},
    process() {
      if (index >= states.length) {
        return "silence";
      }
      const state = states[index]!;
      index += 1;
      return state;
    },
  } as unknown as VoiceActivityDetector;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("platformSpeechStart cancels a deferred platform wait", async () => {
  const channel = new FakeAudioChannel();
  const resultPromise = collectUntilEndOfTurn(channel, {
    vad: makeFakeVAD(["speech", "end_of_turn"]),
    preferPlatformEOT: true,
    timeoutMs: 5000,
    debugLabel: "test-resume",
  });

  channel.emit("audio", Buffer.alloc(960));
  channel.emit("audio", Buffer.alloc(960));
  await delay(20);
  channel.emit("platformSpeechStart");

  const stillWaiting = await Promise.race([
    resultPromise.then(() => false),
    delay(100).then(() => true),
  ]);

  assert.equal(stillWaiting, true);

  channel.markDisconnected();
  const result = await resultPromise;
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
});

test("disconnected resolves collection before timeout", async () => {
  const channel = new FakeAudioChannel();
  const startedAt = Date.now();
  const resultPromise = collectUntilEndOfTurn(channel, {
    vad: makeFakeVAD([]),
    timeoutMs: 5000,
    debugLabel: "test-disconnect",
  });

  setTimeout(() => {
    channel.markDisconnected();
  }, 20);

  const result = await resultPromise;
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.ok(elapsedMs < 1000);
});
