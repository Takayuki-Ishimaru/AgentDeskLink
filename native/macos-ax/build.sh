#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build/ADLFixture.app/Contents/MacOS
swiftc -swift-version 5 -target arm64-apple-macos14.0 -typecheck -strict-concurrency=complete -warnings-as-errors src/Contract.swift src/Capture.swift src/Interactive.swift src/Lifecycle.swift src/main.swift
swiftc -swift-version 5 -target arm64-apple-macos14.0 -O src/Contract.swift src/Capture.swift src/Interactive.swift src/Lifecycle.swift src/main.swift -o build/adl-macos-ax-helper
swiftc -swift-version 5 -target arm64-apple-macos14.0 -O fixture/main.swift -o build/ADLFixture.app/Contents/MacOS/ADLFixture
cat > build/ADLFixture.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.agentdesklink.fixture</string><key>CFBundleExecutable</key><string>ADLFixture</string><key>CFBundleName</key><string>ADL Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>
PLIST
codesign --force --sign - build/adl-macos-ax-helper
codesign --force --sign - build/ADLFixture.app

rm -rf build/ADLHuman.app
cp -R build/ADLFixture.app build/ADLHuman.app
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier local.agentdesklink.human' build/ADLHuman.app/Contents/Info.plist
codesign --force --sign - build/ADLHuman.app
swiftc -swift-version 5 -target arm64-apple-macos14.0 -O tools/monitor.swift -o build/adl-macos-monitor

swiftc -swift-version 5 -target "$(uname -m)-apple-macos14.0" -O src/Contract.swift tests/main.swift -o build/adl-macos-contract-tests
build/adl-macos-contract-tests

swiftc -swift-version 5 -target "$(uname -m)-apple-macos14.0" -O src/Contract.swift tests/semantic/main.swift -o build/adl-semantic-replay-tests
build/adl-semantic-replay-tests tests/semantic/cases.json

swiftc -swift-version 5 -target "$(uname -m)-apple-macos14.0" -O src/Contract.swift src/Capture.swift src/Interactive.swift src/Lifecycle.swift tests/lifecycle/main.swift -o build/adl-macos-lifecycle-tests
build/adl-macos-lifecycle-tests

swiftc -swift-version 5 -target "$(uname -m)-apple-macos14.0" -O src/Contract.swift src/Capture.swift src/Interactive.swift tests/capture/main.swift -o build/adl-macos-capture-tests
build/adl-macos-capture-tests

swiftc -swift-version 5 -target "$(uname -m)-apple-macos14.0" -O src/Contract.swift src/Capture.swift src/Interactive.swift tests/interactive/main.swift -o build/adl-macos-interactive-tests
build/adl-macos-interactive-tests

swiftc -swift-version 5 -target "$(uname -m)-apple-macos14.0" -O src/Contract.swift src/Capture.swift src/Interactive.swift tests/recovery-probe/main.swift -o build/adl-macos-recovery-probe
codesign --force --sign - build/adl-macos-recovery-probe
