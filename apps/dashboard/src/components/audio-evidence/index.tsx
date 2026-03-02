import type { AudioTestResult } from "@/lib/types";
import { EchoEvidence } from "./echo-evidence";
import { BargeInEvidence } from "./barge-in-evidence";
import { TtfbEvidence } from "./ttfb-evidence";
import { SilenceEvidence } from "./silence-evidence";
import { ConnectionEvidence } from "./connection-evidence";
import { CompletenessEvidence } from "./completeness-evidence";
import { NoiseEvidence } from "./noise-evidence";
import { EndpointingEvidence } from "./endpointing-evidence";
import { AudioQualityEvidence } from "./audio-quality-evidence";

interface AudioTestEvidenceProps {
  result: AudioTestResult;
}

export function AudioTestEvidence({ result }: AudioTestEvidenceProps) {
  const { metrics } = result;

  switch (result.test_name) {
    case "echo":
      return <EchoEvidence metrics={metrics} />;
    case "barge_in":
      return <BargeInEvidence metrics={metrics} />;
    case "ttfb":
      return <TtfbEvidence metrics={metrics} />;
    case "silence_handling":
      return <SilenceEvidence metrics={metrics} />;
    case "connection_stability":
      return <ConnectionEvidence metrics={metrics} />;
    case "response_completeness":
      return <CompletenessEvidence metrics={metrics} />;
    case "noise_resilience":
      return <NoiseEvidence metrics={metrics} />;
    case "endpointing":
      return <EndpointingEvidence metrics={metrics} />;
    case "audio_quality":
      return <AudioQualityEvidence metrics={metrics} />;
    default:
      return (
        <div className="text-sm text-muted-foreground">
          No detailed evidence view available for this test.
        </div>
      );
  }
}
