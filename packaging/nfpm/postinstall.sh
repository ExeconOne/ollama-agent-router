#!/bin/sh
set -eu

if ! id ollama-agent-router >/dev/null 2>&1; then
  useradd --system --home /var/lib/ollama-agent-router --shell /usr/sbin/nologin ollama-agent-router || true
fi

mkdir -p /etc/ollama-agent-router

if [ ! -f /etc/ollama-agent-router/config.yaml ]; then
  cp /usr/share/ollama-agent-router/examples/gex44.yaml /etc/ollama-agent-router/config.yaml
fi
