#!/bin/bash
# Run one command inside a headless accessibility desktop: a private Xvfb display, a private D-Bus
# session and its own AT-SPI bus. Only processes started here are stopped afterwards.
# usage: native/linux-atspi/tests/run-xvfb.sh <command...>
set -u
DISPLAY_NUMBER="${ADL_XVFB_DISPLAY:-99}"
export DISPLAY=":${DISPLAY_NUMBER}"
export ADL_LINUX_ATSPI_E2E=1
export NO_AT_BRIDGE=0
unset WAYLAND_DISPLAY
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >/tmp/adl-xvfb-"$DISPLAY_NUMBER".log 2>&1 &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null' EXIT
for _ in $(seq 1 50); do
  if [ -S "/tmp/.X11-unix/X${DISPLAY_NUMBER}" ]; then break; fi
  sleep 0.1
done
# The inner shell owns the a11y bus launcher; the session bus dies with dbus-run-session.
timeout --kill-after=10 "${ADL_XVFB_TIMEOUT:-600}" dbus-run-session -- bash -c '
  /usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/adl-a11y-bus.log 2>&1 &
  BUS_PID=$!
  sleep 1
  # Optional real X11 window manager (ADL_WM=openbox): windows then get STATE_ACTIVE/FOCUSED like on a desktop session.
  WM_PID=
  if [ -n "${ADL_WM:-}" ]; then
    "$ADL_WM" >/tmp/adl-wm.log 2>&1 &
    WM_PID=$!
    sleep 1
  fi
  "$@"
  rc=$?
  kill "$BUS_PID" $WM_PID 2>/dev/null
  exit $rc
' _ "$@"
exit $?
