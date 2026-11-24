#!/bin/sh
# One command to go from a checkout to a working workbench.
#
#   pnpm quickstart
#
# It builds only what is missing, checks the environment, starts the local
# workbench on 17899 and opens it in the browser. Ctrl+C stops the server.
set -e
cd "$(dirname "$0")/.."

if [ ! -f dist/cli.js ]; then
  echo "==> building CueKeeper"
  pnpm install --frozen-lockfile
  pnpm build
fi

if [ ! -x dist/cuekeeper-capture ]; then
  echo "==> building the capture helper"
  pnpm build:recorder
fi

echo "==> checking environment (accessibility, input monitoring, agent-desktop)"
node dist/cli.js doctor || {
  echo
  echo "doctor reported a problem. Grant the listed permissions in System Settings,"
  echo "then run: pnpm quickstart"
  exit 1
}

echo "==> starting the workbench on http://127.0.0.1:17899"
node dist/cli.js workbench --port 17899 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' INT TERM EXIT

sleep 1
if command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:17899" || true
fi

echo
echo "Workbench: http://127.0.0.1:17899"
echo "Press Ctrl+C to stop."
wait $SERVER
