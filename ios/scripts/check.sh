#!/bin/bash
set -euo pipefail

phase=${1:-all}
if (( $# > 1 )); then
  printf 'Usage: %s [all|host|simulator]\n' "$0" >&2
  exit 64
fi
case "$phase" in
  all|host|simulator) ;;
  *) printf 'Usage: %s [all|host|simulator]\n' "$0" >&2; exit 64 ;;
esac

native_dir=$(cd "$(dirname "$0")/.." && pwd)
repo_root=$(cd "$native_dir/.." && pwd)
mkdir -p "$repo_root/target/ios-validation"
run_dir=$(mktemp -d "$repo_root/target/ios-validation/run.XXXXXX")
printf 'Native validation output: %s\n' "$run_dir"
printf 'Native validation phase: %s\n' "$phase"
performance_test=pagedHistoryAndStreamingPreparationRemainBoundedAndKeepCanonicalIdentity
if [[ "$phase" != simulator ]]; then
  plutil -lint "$native_dir/Agent.xcodeproj/project.pbxproj" \
    "$native_dir/AgentApp/PrivacyInfo.xcprivacy" "$native_dir/TestFlightExport.plist"

  # Rust's exporter owns Generated.swift and its formatting.
  xcrun swift-format lint --strict "$native_dir/Package.swift"
  find "$native_dir/AgentApp" "$native_dir/Sources" "$native_dir/Tests" \
    -name '*.swift' ! -name Generated.swift -print0 \
    | xargs -0 xcrun swift-format lint --strict
  mkdir "$run_dir/macos-rendered"
  swift test --package-path "$native_dir" --scratch-path "$run_dir/macos" \
    --attachments-path "$run_dir/macos-rendered"
  swift test --configuration release --package-path "$native_dir" \
    --scratch-path "$run_dir/macos" --filter "$performance_test" \
    --attachments-path "$run_dir/macos-rendered"
  xcodebuild -quiet -project "$native_dir/Agent.xcodeproj" -scheme Agent \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$run_dir/app" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO build
fi
if [[ "$phase" == host ]]; then
  exit 0
fi

xcrun simctl list runtimes --json > "$run_dir/runtimes.json"
xcrun simctl list devicetypes --json > "$run_dir/device-types.json"
python3 - "$run_dir" "$native_dir" <<'PY'
import json
import sys
from pathlib import Path
from xml.sax.saxutils import escape

run = Path(sys.argv[1])


def version(value: str) -> tuple[int, int, int]:
    parts = [int(part) for part in value.split(".")]
    return tuple((parts + [0, 0, 0])[:3])


runtimes = sorted(
    (runtime for runtime in json.loads((run / "runtimes.json").read_text())["runtimes"]
     if runtime.get("isAvailable")
     and runtime["identifier"].startswith("com.apple.CoreSimulator.SimRuntime.iOS-")
     and version(runtime["version"]) >= (18, 0, 0)),
    key=lambda runtime: version(runtime["version"]), reverse=True,
)
devices = json.loads((run / "device-types.json").read_text())["devicetypes"]
for runtime in runtimes:
    major, minor, patch = version(runtime["version"])
    packed_version = (major << 16) | (minor << 8) | patch
    supported = ({device["identifier"] for device in runtime["supportedDeviceTypes"]}
                 if "supportedDeviceTypes" in runtime else None)
    device = next((device for device in devices
                   if device.get("productFamily") == "iPhone"
                   and (supported is None or device["identifier"] in supported)
                   and device["minRuntimeVersion"] <= packed_version <= device["maxRuntimeVersion"]), None)
    if device is not None:
        (run / "simulator-selection").write_text(f'{runtime["identifier"]}\t{device["identifier"]}\n')
        print(f'Using {device["name"]} with {runtime["name"]}')
        break
else:
    sys.exit("No available installed iOS Simulator runtime with a compatible iPhone. Install one in Xcode before running native checks.")

# Opening the package as a workspace root exposes its real test scheme.
# The app project's dependency scheme has no package tests.
workspace = run / "NativeTests.xcworkspace"
workspace.mkdir()
native = escape(sys.argv[2], {'"': "&quot;"})
(workspace / "contents.xcworkspacedata").write_text(
    f'<?xml version="1.0" encoding="UTF-8"?>\n'
    f'<Workspace version="1.0"><FileRef location="absolute:{native}" /></Workspace>\n'
)
PY

IFS=$'\t' read -r runtime_id device_type_id < "$run_dir/simulator-selection"
simulator_id=
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$simulator_id" ]]; then
    xcrun simctl shutdown "$simulator_id" >/dev/null 2>&1 || true
    if ! xcrun simctl delete "$simulator_id"; then
      printf 'Could not remove task-owned simulator %s\n' "$simulator_id" >&2
      status=1
    fi
  fi
  if (( status != 0 )); then
    local suite bundle
    for suite in core performance rendering; do
      bundle="$run_dir/ios-$suite-tests.xcresult"
      if [[ -d "$bundle" ]]; then
        printf 'iOS Simulator %s result:\n' "$suite" >&2
        if ! xcrun xcresulttool get test-results summary --path "$bundle" --compact \
          | tee "$run_dir/ios-$suite-summary.json"; then
          printf 'Could not summarize %s\n' "$bundle" >&2
        fi
      fi
    done
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

simulator_id=$(xcrun simctl create "Agent native checks $(basename "$run_dir")" "$device_type_id" "$runtime_id")
xcrun simctl boot "$simulator_id"
xcrun simctl bootstatus "$simulator_id" -b
xcodebuild -quiet -workspace "$run_dir/NativeTests.xcworkspace" -scheme AgentCoreTests \
  -destination "platform=iOS Simulator,id=$simulator_id" -destination-timeout 60 \
  -parallel-testing-enabled NO -derivedDataPath "$run_dir/tests" \
  -resultBundlePath "$run_dir/ios-core-tests.xcresult" CODE_SIGNING_ALLOWED=NO test
xcodebuild -quiet -workspace "$run_dir/NativeTests.xcworkspace" -scheme AgentCoreTests \
  -configuration Release -only-testing:"AgentCoreTests/$performance_test()" \
  -destination "platform=iOS Simulator,id=$simulator_id" -destination-timeout 60 \
  -parallel-testing-enabled NO -derivedDataPath "$run_dir/tests" \
  -resultBundlePath "$run_dir/ios-performance-tests.xcresult" \
  CODE_SIGNING_ALLOWED=NO ENABLE_TESTABILITY=YES test
xcodebuild -quiet -project "$native_dir/Agent.xcodeproj" -scheme Agent \
  -destination "platform=iOS Simulator,id=$simulator_id" -destination-timeout 60 \
  -parallel-testing-enabled NO -derivedDataPath "$run_dir/app" \
  -resultBundlePath "$run_dir/ios-rendering-tests.xcresult" CODE_SIGNING_ALLOWED=NO test
for suite in core performance rendering; do
  xcrun xcresulttool get test-results summary --path "$run_dir/ios-$suite-tests.xcresult" \
    --compact > "$run_dir/ios-$suite-summary.json"
  python3 - "$run_dir/ios-$suite-summary.json" "$suite" <<'PY'
import json
import sys
from pathlib import Path

summary = json.loads(Path(sys.argv[1]).read_text())
if summary["result"] != "Passed" or summary["passedTests"] <= 0 or summary["failedTests"] != 0:
    sys.exit(f'iOS tests did not produce a nonempty passing result: {summary}')
print(f'iOS Simulator {sys.argv[2]}: {summary["passedTests"]}/{summary["totalTestCount"]} tests passed')
PY
done
