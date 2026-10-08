#!/bin/sh
# agentwatch one-liner for macOS/Linux:
#   curl -fsSL https://raw.githubusercontent.com/piemvibes-hue/agentwatch/main/install.sh | sh
set -e
dir="$HOME/.agentwatch/app"
if [ -d "$dir" ]; then git -C "$dir" pull --ff-only; else git clone https://github.com/piemvibes-hue/agentwatch.git "$dir"; fi
node "$dir/src/cli.js" install
echo ""
echo "agentwatch is watching. Dashboard: http://127.0.0.1:8787  (uninstall: node $dir/src/cli.js uninstall)"
