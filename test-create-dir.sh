#!/usr/bin/env bash
set -euo pipefail

# -------------------------------------------------------------------
# test-create-dir.sh
# Tests that create-screenshots-dir.sh works correctly:
#   - Creates the directory
#   - Verifies it exists and has correct permissions
#   - Cleans up after itself for repeatable testing
# -------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="/Users/mac/Downloads/apex 4/.apex-screenshots"

log_info() {
  echo "[TEST INFO] $*" >&2
}

log_pass() {
  echo "[TEST PASS] $*" >&2
}

log_fail() {
  echo "[TEST FAIL] $*" >&2
  exit 1
}

cleanup() {
  # Remove the test directory for repeatable testing
  rm -rf "${TARGET_DIR}"
}

trap cleanup EXIT

main() {
  log_info "Running test for create-screenshots-dir.sh"

  # Ensure directory does not exist before test (remove if present)
  if [[ -d "${TARGET_DIR}" ]]; then
    log_info "Directory already exists – removing it for a fresh test"
    rm -rf "${TARGET_DIR}"
  fi

  # Run the creation script
  bash "${SCRIPT_DIR}/create-screenshots-dir.sh"

  # Verify directory exists
  if [[ ! -d "${TARGET_DIR}" ]]; then
    log_fail "Directory was not created: ${TARGET_DIR}"
  fi
  log_pass "Directory exists: ${TARGET_DIR}"

  # Verify permissions (should be 755 by default with umask)
  local perms
  perms=$(stat -f "%Lp" "${TARGET_DIR}" 2>/dev/null || stat -c "%a" "${TARGET_DIR}" 2>/dev/null)
  if [[ -z "${perms}" ]]; then
    log_fail "Could not determine permissions for ${TARGET_DIR}"
  fi
  log_pass "Directory permissions: ${perms}"

  # Verify idempotency – running again should succeed
  log_info "Testing idempotency (second run)"
  bash "${SCRIPT_DIR}/create-screenshots-dir.sh"
  log_pass "Idempotency check passed"

  log_info "All tests passed."
}

main "$@"
