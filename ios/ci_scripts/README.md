# TestFlight delivery from main

Xcode Cloud owns signing and distribution. Its workflow settings live in
App Store Connect; this directory supplies the archive's additional test gate.
No signing certificates, API keys or developer account identifiers belong in
the repository.

`Shared.xcconfig` reads the signing team from Apple's built-in `CI_TEAM_ID`.
Local signed builds can override `DEVELOPMENT_TEAM` without committing an
account identifier. The host and embedded Share extension need the same
provisioned App Group; see [native setup](../README.md#build-and-connect).

Configure one release workflow:

| Setting | Value |
| --- | --- |
| Project | `ios/Agent.xcodeproj` |
| Scheme | `Agent` |
| Start condition | Branch Changes, exact branch `main`, any file in `/ios` |
| Superseded builds | Auto-cancel enabled |
| Environment | Xcode 27.1 (27A9275), macOS 27.0.1 (26A434) |
| Test action | iOS, `Agent`, Use Scheme Settings, **Required To Pass** |
| Test destination | A supported iPhone simulator |
| Archive action | iOS, `Agent`, **TestFlight (Internal Testing Only)** |
| Post-action | Successful build, TestFlight Internal Testing, intended private group |

The required Test action retains UI screenshots and test results as native
Xcode Cloud artifacts. Before the archive command, `ci_pre_xcodebuild.sh` runs
the Swift package's behavioral tests and isolated Release performance budgets.
An error exits the hook and fails the archive. The hook also rejects archives
from other branches or pull requests. It installs no dependencies and uses no
model credentials or live coordinator.

The `/ios` filter includes the app, generated native contracts, package tests
and release scripts. CLI-only and runtime-only changes do not create a signed
iOS build. Manual starts from `main` remain available.

Pin Xcode and host macOS together. Qualify both appearance audits on Cloud
before advancing either version. The top form, revealed footer and empty main
view each use a fresh app launch. UI cases use the standard XCTest hang guard
of 600 seconds for the whole case; product latency has separate performance
tests.

Keep GitHub's native and shared-protocol checks enabled for pull requests and
`main`. Xcode Cloud provides the signed delivery step and its own required
native checks; it does not inherit the status of another CI provider's jobs.

Initialize the first workflow from Xcode's Report navigator → Cloud →
Get Started, select the existing app and intended developer team, and grant
the Xcode Cloud GitHub integration access to this repository only. Select the
existing App Store Connect record. After initialization, edit the settings
above in Xcode or App Store Connect.

Choose the private group in the Cloud post-action explicitly. The group's
automatic distribution setting for Xcode uploads does not apply to Cloud builds.

Before the first distribution, set **Xcode Cloud → Settings → Build Number →
Next Build Number** above the highest manually uploaded build for the current
marketing version. Let Xcode Cloud increment it afterwards. Switching from a
manual build to Cloud build `1` without changing the marketing version can
collide with an existing upload.

Verify the first main-branch build in App Store Connect: the required tests and
archive must pass, the commit must match the intended push, the TestFlight
build must say **Internal**, and the selected private group must receive it.
Hook presence alone does not establish that the account's workflow is enabled
or that a signed upload succeeded.

Apple references:

- [First workflow setup](https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow)
- [Workflow actions](https://developer.apple.com/documentation/xcode/configuring-your-xcode-cloud-workflow-s-actions)
- [Custom scripts](https://developer.apple.com/documentation/xcode/writing-custom-build-scripts)
- [Internal TestFlight delivery](https://developer.apple.com/documentation/xcode/creating-a-workflow-that-builds-your-app-for-distribution)
- [Cloud build numbers](https://developer.apple.com/documentation/xcode/setting-the-next-build-number-for-xcode-cloud-builds)
- [Built-in environment variables](https://developer.apple.com/documentation/xcode/environment-variable-reference)
