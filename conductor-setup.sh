#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Conductor layout: conductor/workspaces/<repo>/<name> → conductor/repos/<repo>
WORKSPACES_DIR="$(dirname "$PROJECT_ROOT")"
REPO_NAME="$(basename "$WORKSPACES_DIR")"
CONDUCTOR_ROOT="$(cd "$WORKSPACES_DIR/../.." 2>/dev/null && pwd || echo "")"
CONDUCTOR_REPO_ROOT="${CONDUCTOR_ROOT:+$CONDUCTOR_ROOT/repos/$REPO_NAME}"

cd "$PROJECT_ROOT"

STEP_STARTED=0

step() {
  if [ "$STEP_STARTED" -eq 1 ]; then
    printf '\n'
  fi
  STEP_STARTED=1
  printf '==> %s\n' "$1"
}

info() {
  printf '  - %s\n' "$1"
}

# ── 1. Copy env files ─────────────────────────────────────────────────────────

file_mtime() {
  local filename="$1"
  if stat -f "%m" "$filename" >/dev/null 2>&1; then
    stat -f "%m" "$filename"
  else
    stat -c "%Y" "$filename"
  fi
}

find_latest_env_source() {
  local filename="$1"
  local candidates=()
  local sibling=""
  local best=""
  local best_mtime=0
  local candidate=""
  local candidate_mtime=0

  if [ -n "$CONDUCTOR_REPO_ROOT" ] && [ -f "$CONDUCTOR_REPO_ROOT/$filename" ]; then
    candidates+=("$CONDUCTOR_REPO_ROOT/$filename")
  fi

  if [ -d "$WORKSPACES_DIR" ]; then
    for sibling in "$WORKSPACES_DIR"/*/; do
      sibling="${sibling%/}"
      if [ "$sibling" != "$PROJECT_ROOT" ] && [ -f "$sibling/$filename" ]; then
        candidates+=("$sibling/$filename")
      fi
    done
  fi

  for candidate in "${candidates[@]}"; do
    candidate_mtime="$(file_mtime "$candidate")"
    if [ -z "$best" ] || [ "$candidate_mtime" -gt "$best_mtime" ]; then
      best="$candidate"
      best_mtime="$candidate_mtime"
    fi
  done

  printf '%s\n' "$best"
}

sync_env_file() {
  local filename="$1"
  local shared_copy=""
  local current_mtime=0
  local shared_mtime=0

  if [ -z "$CONDUCTOR_REPO_ROOT" ] || [ ! -f "$filename" ]; then
    return 0
  fi

  shared_copy="$CONDUCTOR_REPO_ROOT/$filename"
  mkdir -p "$CONDUCTOR_REPO_ROOT"

  if [ ! -f "$shared_copy" ]; then
    cp "$filename" "$shared_copy"
    info "$filename: saved shared copy"
    return 0
  fi

  if cmp -s "$filename" "$shared_copy"; then
    info "$filename: shared copy already current"
    return 0
  fi

  current_mtime="$(file_mtime "$filename")"
  shared_mtime="$(file_mtime "$shared_copy")"
  if [ "$current_mtime" -ge "$shared_mtime" ]; then
    cp "$filename" "$shared_copy"
    info "$filename: refreshed shared copy"
  else
    info "$filename: kept newer shared copy"
  fi
}

ensure_env_file() {
  local filename="$1"
  local source=""

  if [ -f "$filename" ]; then
    info "$filename: keeping workspace copy"
    sync_env_file "$filename"
    return 0
  fi

  source="$(find_latest_env_source "$filename")"
  if [ -z "$source" ]; then
    echo ""
    printf 'ERROR: No saved %s found for this Conductor repo\n' "$filename" >&2
    if [ -n "$CONDUCTOR_REPO_ROOT" ]; then
      printf '  Add a real %s to %s or another workspace under %s\n' "$filename" "$CONDUCTOR_REPO_ROOT/$filename" "$WORKSPACES_DIR" >&2
    else
      printf '  Add a real %s to another workspace\n' "$filename" >&2
    fi
    exit 1
  fi

  cp "$source" "$filename"
  info "$filename: copied from $source"
  sync_env_file "$filename"
}

step "Transfer env"
ensure_env_file ".env"

step "Install dependencies"
pnpm install

step "Build project"
pnpm build

step "Done"
info "Workspace ready"
