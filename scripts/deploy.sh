#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

TARGET_DIR="${TARGET_DIR:-/opt/outside-orchestrator}"
SERVICE_NAME="${SERVICE_NAME:-outside-orchestrator}"
HEALTH_PORT="${HEALTH_PORT:-3000}"

echo "================================================================="
echo "Outside Orchestrator — Automated Hostinger VPS Deployment"
echo "================================================================="
echo "Target Directory: ${TARGET_DIR}"
echo "Service Name:     ${SERVICE_NAME}"
echo "Health Port:      ${HEALTH_PORT}"
echo "Timestamp:        $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "================================================================="

if [ ! -d "${TARGET_DIR}" ]; then
  echo "✖ Target directory ${TARGET_DIR} does not exist!"
  exit 1
fi

cd "${TARGET_DIR}"

echo "[1/5] Synchronizing latest code from origin/main..."
git fetch origin main
git reset --hard origin/main

echo "[2/5] Compiling TypeScript source..."
npm run build

echo "[3/5] Verifying Policy-as-Code & Security Invariants..."
node dist/scripts/lint-policy.js

SUDO_CMD=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO_CMD="sudo"
fi

echo "[4/5] Restarting systemd service (${SERVICE_NAME})..."
if command -v systemctl >/dev/null 2>&1; then
  ${SUDO_CMD} systemctl daemon-reload || true
  ${SUDO_CMD} systemctl restart "${SERVICE_NAME}"
else
  echo "⚠ systemctl not found, skipping service restart."
fi

echo "[5/5] Performing post-deployment health verification..."
sleep 3

# Verify systemd service status if available
if command -v systemctl >/dev/null 2>&1; then
  if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    echo "✖ Deployment verification failed: ${SERVICE_NAME} is not active!"
    systemctl status "${SERVICE_NAME}" --no-pager || true
    exit 1
  fi
  echo "✔ Systemd service is active (running)."
fi

# Verify HTTP health endpoint
HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
RETRIES=5
SUCCESS=0

for i in $(seq 1 $RETRIES); do
  RESPONSE=$(curl -s --fail "${HEALTH_URL}" 2>/dev/null || true)
  if echo "${RESPONSE}" | grep -q '"status":"ok"'; then
    echo "✔ Health probe succeeded: ${RESPONSE}"
    SUCCESS=1
    break
  fi
  echo "Waiting for service to become healthy (attempt $i/$RETRIES)..."
  sleep 2
done

if [ "$SUCCESS" -ne 1 ]; then
  echo "✖ Health probe failed after $RETRIES attempts on ${HEALTH_URL}"
  exit 1
fi

echo "================================================================="
echo "✔ DEPLOYMENT COMPLETED & VERIFIED SUCCESSFULLY"
echo "================================================================="
