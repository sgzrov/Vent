#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_match() {
  local pattern="$1"
  local file="$2"
  if ! rg -q "$pattern" "$file"; then
    echo "FAILED: expected pattern '$pattern' in $file"
    exit 1
  fi
}

forbid_match() {
  local pattern="$1"
  local file="$2"
  if rg -q "$pattern" "$file"; then
    echo "FAILED: forbidden pattern '$pattern' found in $file"
    exit 1
  fi
}

# Auth split: verifyApiKey must not be alias-only.
require_match "app\\.decorate\\(\"verifyApiKey\", verifyApiKey\\)" "apps/api/src/plugins/auth.ts"
forbid_match "app\\.decorate\\(\"verifyApiKey\", verifyAuth\\)" "apps/api/src/plugins/auth.ts"

# CORS should not default to open true.
forbid_match "origin:\\s*process\\.env\\[\"DASHBOARD_URL\"\\]\\s*\\?\\?\\s*true" "apps/api/src/index.ts"

# Queued stuck-run cleanup must be relay-scoped.
require_match "eq\\(schema\\.runs\\.source_type, \"relay\"\\)" "apps/api/src/index.ts"

# Run-status read must be user-scoped.
require_match "eq\\(schema\\.runs\\.user_id, userId\\)" "apps/api/src/routes/mcp/tools/action-tools.ts"

# Tool-call eval should fail when requested but no tool calls are observed.
require_match "No tool calls were observed in this run" "apps/runner/src/conversation/executor.ts"

# Dashboard should not render stack traces in error boundaries.
forbid_match "error\\.stack" "apps/dashboard/src/app/error.tsx"
forbid_match "error\\.stack" "apps/dashboard/src/app/global-error.tsx"

# Filler rate should not be multiplied again in UI.
forbid_match "filler_word_rate \\* 100" "apps/dashboard/src/components/conversation-metrics-panel.tsx"

echo "Hardening checks passed."
