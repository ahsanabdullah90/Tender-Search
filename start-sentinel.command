#!/bin/bash
cd "$(dirname "$0")"
echo "========================================================"
echo "Starting Sentinel - Pakistan Procurement Watchdog"
echo "Solo-Operator Local Edition (http://localhost:3000)"
echo "========================================================"

open http://localhost:3000 || xdg-open http://localhost:3000 2>/dev/null &
npm run dev
