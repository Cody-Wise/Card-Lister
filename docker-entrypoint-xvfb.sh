#!/bin/sh
# Manual Xvfb startup instead of the xvfb-run wrapper — xvfb-run's -a
# (auto-servernum) hung indefinitely on a real production run (container
# came up, Xvfb itself started, but xvfb-run never got to exec'ing the
# actual command). Starting Xvfb directly on a fixed display number and
# execing node ourselves is simpler and has one less layer to hang in.
set -e

Xvfb :99 -screen 0 1920x1080x24 &
XVFB_PID=$!

# Give Xvfb a moment to create its display socket before Chromium (or
# anything else) tries to connect to it.
for i in $(seq 1 20); do
  if [ -e /tmp/.X11-unix/X99 ]; then
    break
  fi
  sleep 0.25
done

export DISPLAY=:99

exec "$@"
