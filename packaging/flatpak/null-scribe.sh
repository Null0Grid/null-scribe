#!/bin/sh
# Flatpak launcher: zypak (from the Electron base app) gives Chromium its sandbox inside Flatpak.
# Wayland when the session has it, X11 otherwise.
exec zypak-wrapper /app/null-scribe/null-scribe --ozone-platform-hint=auto --enable-features=WaylandWindowDecorations "$@"
