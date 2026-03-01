import { execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  TestSpec,
  AdapterType,
  VoiceConfig,
  AudioTestThresholds,
  PlatformConfig,
} from "@voiceci/shared";
import type { AudioChannelConfig } from "@voiceci/adapters";
import { executeTests } from "./executor.js";
import { reportResults, reportTestProgress, reportRunEvent } from "./reporter.js";
import { waitForHealth } from "./health-check.js";

const WORK_DIR = "/work";

async function main() {
  const runId = requireEnv("RUN_ID");
  const bundleDownloadUrl = process.env["BUNDLE_DOWNLOAD_URL"];
  const testSpec = JSON.parse(requireEnv("TEST_SPEC_JSON")) as TestSpec;
  const adapterType = (process.env["ADAPTER_TYPE"] ?? "websocket") as AdapterType;

  console.log(`Runner starting for run ${runId}`);

  // Download and extract bundle (only needed for local agents)
  if (bundleDownloadUrl) {
    mkdirSync(WORK_DIR, { recursive: true });

    void reportRunEvent({ run_id: runId, event_type: "downloading_bundle", message: "Downloading bundle..." });
    console.log("Downloading bundle...");
    const response = await fetch(bundleDownloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download bundle: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    writeFileSync("/tmp/bundle.tar.gz", Buffer.from(arrayBuffer));

    void reportRunEvent({ run_id: runId, event_type: "extracting_bundle", message: "Extracting bundle..." });
    console.log("Extracting bundle...");
    execSync(`tar -xzf /tmp/bundle.tar.gz -C ${WORK_DIR}`, { stdio: "inherit" });
  }

  // Parse voice config from env
  let voiceConfig: VoiceConfig | undefined;
  const voiceConfigJson = process.env["VOICE_CONFIG_JSON"];
  if (voiceConfigJson) {
    const parsed = JSON.parse(voiceConfigJson) as Record<string, unknown>;
    voiceConfig = (parsed.voice as VoiceConfig) ?? undefined;
  }

  // Parse audio test thresholds from env
  let audioTestThresholds: AudioTestThresholds | undefined;
  const thresholdsJson = process.env["AUDIO_TEST_THRESHOLDS_JSON"];
  if (thresholdsJson) {
    audioTestThresholds = JSON.parse(thresholdsJson) as AudioTestThresholds;
  }

  // Parse platform config from env (for platform-hosted adapters)
  let platformConfig: PlatformConfig | undefined;
  const platformConfigJson = process.env["PLATFORM_CONFIG_JSON"];
  if (platformConfigJson) {
    platformConfig = JSON.parse(platformConfigJson) as PlatformConfig;
  }

  // For remote agents (SIP/WebRTC), skip local agent startup
  const isRemoteAgent =
    adapterType === "sip" ||
    adapterType === "webrtc" ||
    adapterType === "vapi" ||
    adapterType === "retell" ||
    adapterType === "elevenlabs" ||
    adapterType === "bland";
  let agentProcess: ChildProcess | null = null;
  const agentUrl = process.env["AGENT_URL"] ?? "http://localhost:3001";

  if (!isRemoteAgent) {
    if (existsSync(join(WORK_DIR, "node_modules"))) {
      console.log("node_modules present (prebaked image), skipping install");
      void reportRunEvent({ run_id: runId, event_type: "installing_deps", message: "Dependencies prebaked, skipping install" });
    } else {
      void reportRunEvent({ run_id: runId, event_type: "installing_deps", message: "Installing dependencies..." });
      console.log("Installing dependencies...");
      execSync("npm install", { cwd: WORK_DIR, stdio: "inherit" });
    }

    void reportRunEvent({ run_id: runId, event_type: "starting_agent", message: "Starting agent..." });
    const startCmd = process.env["START_COMMAND"] ?? "npm run start";
    console.log(`Starting agent: ${startCmd}`);
    agentProcess = require("node:child_process").spawn(
      startCmd.split(" ")[0]!,
      startCmd.split(" ").slice(1),
      {
        cwd: WORK_DIR,
        stdio: "pipe",
        env: { ...process.env, PORT: "3001" },
        shell: true,
      }
    );

    // Forward agent stdout/stderr so startup failures are visible
    const proc = agentProcess!;
    proc.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[agent] ${data}`);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[agent] ${data}`);
    });

    // Detect if agent exits before health check passes
    const earlyExit = new Promise<never>((_, reject) => {
      proc.on("exit", (code, signal) => {
        reject(new Error(`Agent process exited before health check passed (code=${code}, signal=${signal}). Check [agent] logs above.`));
      });
    });

    const healthEndpoint = process.env["HEALTH_ENDPOINT"] ?? "/health";
    void reportRunEvent({ run_id: runId, event_type: "health_check_waiting", message: "Waiting for health check..." });
    console.log(`Waiting for agent health at ${agentUrl}${healthEndpoint}...`);
    await Promise.race([
      waitForHealth(`${agentUrl}${healthEndpoint}`),
      earlyExit,
    ]);
    await reportRunEvent({ run_id: runId, event_type: "health_check_passed", message: "Health check passed" });
    console.log("Agent is ready");
  } else {
    console.log(`Using remote agent (${adapterType} adapter)`);
  }

  const channelConfig: AudioChannelConfig = {
    adapter: adapterType,
    agentUrl,
    targetPhoneNumber: process.env["TARGET_PHONE_NUMBER"],
    voice: voiceConfig,
    platform: platformConfig,
  };

  try {
    const totalTests =
      (testSpec.audio_tests?.length ?? 0) + (testSpec.conversation_tests?.length ?? 0);
    let completedTests = 0;

    const { status, audioResults, conversationResults, aggregate } = await executeTests({
      testSpec,
      channelConfig,
      audioTestThresholds,
      onTestStart: (info) => {
        void reportRunEvent({
          run_id: runId,
          event_type: "test_started",
          message: `Started: ${info.test_name}`,
          metadata_json: { test_name: info.test_name, test_type: info.test_type },
        });
      },
      onTestComplete: (result) => {
        completedTests++;
        const isAudio = "test_name" in result;
        void reportTestProgress({
          run_id: runId,
          completed: completedTests,
          total: totalTests,
          test_type: isAudio ? "audio" : "conversation",
          test_name: isAudio
            ? (result as { test_name: string }).test_name
            : (result as { name?: string }).name ?? "conversation",
          status: result.status,
          duration_ms: result.duration_ms,
          result: result as unknown as Record<string, unknown>,
        });
      },
    });

    await reportRunEvent({
      run_id: runId,
      event_type: "run_complete",
      message: `Run complete: ${status}`,
      metadata_json: { status, aggregate },
    });

    await reportResults({
      run_id: runId,
      status,
      audio_results: audioResults,
      conversation_results: conversationResults,
      aggregate,
    });
  } finally {
    agentProcess?.kill("SIGTERM");
  }
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
}

main().then(() => {
  console.log("Runner finished successfully, exiting.");
  process.exit(0);
}).catch((err) => {
  console.error("Runner failed:", err);
  process.exit(1);
});
