#!/bin/bash
cd "$(dirname "$0")"
echo "🏀 Starting CourtIQ..."

# Start the server in the background, then open Chrome once it's ready
node server.js &
NODE_PID=$!

# Wait for server to be ready (up to 10 seconds)
for i in $(seq 1 10); do
  sleep 1
  if curl -s http://localhost:3003 > /dev/null 2>&1; then
    open -a "Google Chrome" http://localhost:3003
    break
  fi
done

# Keep terminal open so server keeps running
wait $NODE_PID
