#!/bin/sh
# One-time setup on a bare Mac (Apple silicon, no Homebrew): uv (user-level), Python 3.12, the locked
# dependencies, and the model weights (about 20 GB, into ~/.cache/huggingface). Safe to run again.
set -eu
cd "$(dirname "$0")/.."
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  . "$HOME/.local/bin/env"
fi
uv python install 3.12
uv sync --script clean/memex_clean.py
uvx --from huggingface_hub hf download mlx-community/Qwen3.6-35B-A3B-4bit
echo "ready: uv run clean/memex_clean.py --in <export dir> --out <clean dir> --held <held dir>"
