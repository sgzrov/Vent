"use client";

import { RunDetailView } from "@/components/run-detail-view";
import { RunsTopChrome } from "@/components/runs-top-chrome";
import { DEMO_RUN } from "@/lib/demo-data";

export default function DemoRunPage() {
  return (
    <div>
      <RunsTopChrome />
      <RunDetailView run={DEMO_RUN} isDemo />
    </div>
  );
}
