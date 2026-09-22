#!/bin/sh
# Starts the runtime builder's esbuild under a hard memory limit. On Linux
# RLIMIT_DATA covers Go's heap and goroutine stacks, so a deeply nested
# source that would grow esbuild's stack towards 1 GiB aborts it instead.
# A Linux host that refuses the limit fails the build (exit 97); macOS does
# not enforce RLIMIT_DATA for mmap, so development relies on the worker
# timeout there.
ulimit -d "${POLKA_ESBUILD_DATA_KB:-524288}" 2>/dev/null ||
  { [ "$(uname -s)" = Linux ] && exit 97; }
# esbuild reports build errors over its stdout protocol; stderr carries only
# Go crash tracebacks (tens of KB each), which stay out of the server logs.
exec "$POLKA_ESBUILD_BINARY" "$@" 2>/dev/null
