// Explicit runtime-only probe: one journalled key-down inside the synthetic fixture.
// Never run by the non-input contract suite. The smoke runner kills it and recovers.
import AppKit
import ApplicationServices
import Darwin
import Foundation
alarm(20)
do{
    guard Array(CommandLine.arguments.dropFirst())==["--key0-down"],NSWorkspace.shared.frontmostApplication?.bundleIdentifier=="local.agentdesklink.fixture" else{throw fail("E_INTERFERENCE_RISK")}
    try requireInputIdle();let lease=try NativeInputLease()
    guard CGPreflightPostEventAccess(),let source=CGEventSource(stateID:.privateState),let down=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:true) else{throw fail("E_BACKEND_UNAVAILABLE")}
    try lease.mark(NativeInputLease.key0);source.localEventsSuppressionInterval=0;down.flags=[];down.post(tap:.cghidEventTap)
    print("{\"owned_key0_down\":true}");fflush(stdout)
    withExtendedLifetime(lease){RunLoop.current.run()}
}catch{FileHandle.standardError.write(Data("Recovery probe unavailable.\n".utf8));exit(2)}
