import type { AudioTestResult } from "@/lib/types";
import { EchoEvidence } from "./echo-evidence";
import { TtfbEvidence } from "./ttfb-evidence";
import { AudioQualityEvidence } from "./audio-quality-evidence";

interface AudioTestEvidenceProps {
  result: AudioTestResult;
}

export function AudioTestEvidence({ result }: AudioTestEvidenceProps) {
  const { metrics } = result;

  switch (result.test_name) {
    case "echo":
      return <EchoEvidence metrics={metrics} />;
    case "latency":
    case "ttfb": // Legacy name maps to same visualization
      return <TtfbEvidence metrics={metrics} />;
    case "audio_quality":
      return <AudioQualityEvidence metrics={metrics} />;
    default:
      // Legacy or unknown tests: show raw metrics in a generic grid
      if (Object.keys(metrics).length === 0) {
        return (
          <div className="text-sm text-muted-foreground">
            No detailed evidence view available for this test.
          </div>
        );
      }
      return null;
  }
}
