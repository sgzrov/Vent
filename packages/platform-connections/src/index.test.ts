import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIdentityKey,
  buildResolvedHash,
  decryptSecrets,
  encryptSecrets,
  mergePlatformConfig,
  splitPlatformConfig,
} from "./index.js";

test("split and merge preserve resolved platform config", () => {
  const platform = {
    provider: "retell" as const,
    retell_api_key: "rk_test",
    retell_agent_id: "agent_123",
    max_concurrency: 4,
  };

  const { config, secrets } = splitPlatformConfig(platform);

  assert.deepEqual(config, {
    provider: "retell",
    retell_agent_id: "agent_123",
    max_concurrency: 4,
  });
  assert.deepEqual(secrets, { retell_api_key: "rk_test" });
  assert.deepEqual(mergePlatformConfig(config, secrets), platform);
});

test("identity keys are stable for provider resources", () => {
  assert.equal(
    buildIdentityKey({
      provider: "vapi",
      vapi_api_key: "key",
      vapi_assistant_id: "assistant_1",
    }),
    "vapi:assistant_1",
  );

  assert.equal(
    buildIdentityKey({
      provider: "livekit",
      livekit_api_key: "key",
      livekit_api_secret: "secret",
      livekit_url: "wss://lk.example",
    }),
    "livekit:wss://lk.example:auto",
  );
});

test("resolved hashes ignore object key order", () => {
  const a = buildResolvedHash({
    provider: "bland",
    bland_api_key: "secret",
    bland_pathway_id: "path_1",
    request_data: { b: 2, a: 1 },
  });
  const b = buildResolvedHash({
    request_data: { a: 1, b: 2 },
    bland_pathway_id: "path_1",
    bland_api_key: "secret",
    provider: "bland",
  });

  assert.equal(a, b);
});

test("encrypt and decrypt round-trip secret payloads", () => {
  process.env.PLATFORM_CONNECTIONS_MASTER_KEY = "0123456789abcdef0123456789abcdef";
  const encrypted = encryptSecrets({
    retell_api_key: "rk_secret",
    livekit_api_secret: "lk_secret",
  });
  const decrypted = decryptSecrets(encrypted);

  assert.deepEqual(decrypted, {
    retell_api_key: "rk_secret",
    livekit_api_secret: "lk_secret",
  });
});
