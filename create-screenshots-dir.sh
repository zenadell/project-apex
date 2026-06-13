#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------------
# create-screenshots-dir.sh
# Creates the directory /Users/mac/Downloads/apex 4/.apex-screenshots/
# using mkdir -p with double quotes to handle the space in the path.
# Idempotent – safe to run multiple times.
# -------------------------------------------------------------------

TARGET_DIR="/Users/mac/Downloads/apex 4/.apex-screenshots"

log_info() {
  echo "[INFO] $*" >&2
}

log_error() {
  echo "[ERROR] $*" >&2
}

main() {
  log_info "Creating directory: ${TARGET_DIR}"

  if mkdir -p "${TARGET_DIR}"; then
    log_info "Directory created (or already exists): ${TARGET_DIR}"
  else
    log_error "Failed to create directory: ${TARGET_DIR}"
    exit 1
  fi
}

main "$@"
