#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MAIN_REPO_ROOT=$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||' || echo "$PROJECT_ROOT")

# Conductor layout: conductor/workspaces/<repo>/<name> → conductor/repos/<repo>
WORKSPACES_DIR="$(dirname "$PROJECT_ROOT")"
REPO_NAME="$(basename "$WORKSPACES_DIR")"
CONDUCTOR_ROOT="$(cd "$WORKSPACES_DIR/../.." 2>/dev/null && pwd || echo "")"
CONDUCTOR_REPO_ROOT="${CONDUCTOR_ROOT:+$CONDUCTOR_ROOT/repos/$REPO_NAME}"

cd "$PROJECT_ROOT"

echo "==> Setting up VoiceCI workspace in $PROJECT_ROOT"

# ── 1. Copy env files ─────────────────────────────────────────────────────────

copy_env_file() {
  local filename="$1"

  # Already exists (e.g. Conductor copied it or previous run)
  if [ -f "$filename" ]; then
    echo "    $filename already exists, keeping it"
    return
  fi

  # Priority 1: Conductor root repo (repos/<name>/.env)
  if [ -n "$CONDUCTOR_REPO_ROOT" ] && [ -f "$CONDUCTOR_REPO_ROOT/$filename" ]; then
    cp "$CONDUCTOR_REPO_ROOT/$filename" "$filename"
    echo "    Copied $filename from $CONDUCTOR_REPO_ROOT (Conductor root repo)"
    return
  fi

  # Priority 2: Git worktree main repo root
  if [ "$MAIN_REPO_ROOT" != "$PROJECT_ROOT" ] && [ -f "$MAIN_REPO_ROOT/$filename" ]; then
    cp "$MAIN_REPO_ROOT/$filename" "$filename"
    echo "    Copied $filename from $MAIN_REPO_ROOT (main worktree)"
    return
  fi

  # Priority 3: Any sibling Conductor workspace that has it
  local workspaces_dir
  workspaces_dir="$(dirname "$PROJECT_ROOT")"
  for sibling in "$workspaces_dir"/*/; do
    sibling="${sibling%/}"
    if [ "$sibling" != "$PROJECT_ROOT" ] && [ -f "$sibling/$filename" ]; then
      cp "$sibling/$filename" "$filename"
      echo "    Copied $filename from $sibling (sibling workspace)"
      return
    fi
  done

  # Priority 4: Any git worktree that has it
  while IFS= read -r line; do
    local wt_path
    wt_path="$(echo "$line" | awk '{print $1}')"
    if [ "$wt_path" != "$PROJECT_ROOT" ] && [ -f "$wt_path/$filename" ]; then
      cp "$wt_path/$filename" "$filename"
      echo "    Copied $filename from $wt_path (git worktree)"
      return
    fi
  done < <(git worktree list 2>/dev/null || true)

  # Last resort: create from example
  if [ -f ".env.example" ]; then
    cp .env.example "$filename"
    echo "    WARNING: Created $filename from .env.example (fill in your secrets!)"
  else
    echo "    ERROR: No $filename source found and no .env.example available"
  fi
}

copy_env_file ".env"

# ── 2. Install dependencies ─────────────────────────────────────────────────

echo "==> Installing dependencies..."
pnpm install

# ── 3. Build all packages ───────────────────────────────────────────────────

echo "==> Building all packages..."
pnpm build

# ── 4. Create .context directory ─────────────────────────────────────────────

if [ ! -d ".context" ]; then
  mkdir -p .context
  touch .context/notes.md .context/todos.md
  echo "    Created .context/ directory"
else
  echo "    .context/ already exists, skipping"
fi

# ── 5. Check voice testing env vars ────────────────────────────────────────

echo "==> Checking voice testing keys..."
VOICE_MISSING=()
for key in ELEVENLABS_API_KEY DEEPGRAM_API_KEY; do
  val="$(grep "^${key}=" .env 2>/dev/null | cut -d= -f2-)"
  if [ -z "$val" ]; then
    VOICE_MISSING+=("$key")
  fi
done

if [ ${#VOICE_MISSING[@]} -gt 0 ]; then
  echo "    Missing voice keys in .env (needed for voice adapters):"
  for key in "${VOICE_MISSING[@]}"; do
    echo "      - $key"
  done
  echo "    Voice testing will not work until these are set."
else
  echo "    Core voice keys present (ElevenLabs, Deepgram)"
fi

echo ""
echo "==> Setup complete!"
echo "    Worktree is ready at $PROJECT_ROOT"
