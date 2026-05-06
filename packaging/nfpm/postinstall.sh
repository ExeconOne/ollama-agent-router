#!/bin/sh
set -eu

if ! getent group ollama-agent-router >/dev/null 2>&1; then
  groupadd --system ollama-agent-router
fi

if ! id -u ollama-agent-router >/dev/null 2>&1; then
  useradd \
    --system \
    --gid ollama-agent-router \
    --home-dir /var/lib/ollama-agent-router \
    --create-home \
    --shell /usr/sbin/nologin \
    ollama-agent-router
fi

mkdir -p /etc/ollama-agent-router
mkdir -p /var/lib/ollama-agent-router
chown ollama-agent-router:ollama-agent-router /var/lib/ollama-agent-router

if [ ! -f /etc/ollama-agent-router/config.yaml ]; then
  cp /usr/share/ollama-agent-router/examples/gex44.yaml /etc/ollama-agent-router/config.yaml
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi
