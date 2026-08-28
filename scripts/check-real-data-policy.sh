#!/usr/bin/env bash
# Real-data policy enforcement — 13_REAL_DATA_POLICY §13.6.
# Thin wrapper: the checks are implemented in Node so they run identically on Windows dev
# machines and Linux CI. Required PR status check.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/check-real-data-policy.mjs
