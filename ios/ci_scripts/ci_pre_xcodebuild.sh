#!/bin/bash
set -euo pipefail

if [[ "${CI_XCODEBUILD_ACTION:-}" != archive ]]; then
  exit 0
fi
if [[ "${CI_BRANCH:-}" != main || -n "${CI_PULL_REQUEST_NUMBER:-}" ]]; then
  printf 'error: TestFlight archives must come from main.\n' >&2
  exit 1
fi

native_dir="${CI_PRIMARY_REPOSITORY_PATH:?}/ios"
run_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-release.XXXXXX")
trap 'rm -rf "$run_dir"' EXIT
mkdir "$run_dir/rendered"

# Xcode Cloud's required Test action owns iOS UI tests and their artifacts.
# Run the package contracts and production performance gates before signing.
swift test --package-path "$native_dir" --scratch-path "$run_dir/build" \
  --attachments-path "$run_dir/rendered"
swift test --configuration release --package-path "$native_dir" \
  --scratch-path "$run_dir/build" --attachments-path "$run_dir/rendered" \
  --filter pagedHistoryAndStreamingPreparationRemainBoundedAndKeepCanonicalIdentity
