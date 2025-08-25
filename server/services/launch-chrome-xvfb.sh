#!/bin/bash
# Launch Chrome with Xvfb virtual display

# Start Xvfb if not already running
if ! pgrep -x "Xvfb" > /dev/null; then
    Xvfb :99 -screen 0 1280x720x24 -ac &
    sleep 2
fi

# Set display
export DISPLAY=:99

# Launch Chrome with all arguments passed
exec "$@"