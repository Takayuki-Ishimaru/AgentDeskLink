import AppKit
import ApplicationServices
import Foundation

struct ManagedApplicationIdentity {
    let pid:pid_t
    let started:String
    func matches(_ pid:pid_t,_ started:String?)->Bool {self.pid==pid && started==self.started}
    func created(after earliest:TimeInterval,excluding prior:Set<pid_t>)->Bool {
        let fields=started.split(separator:":")
        guard !prior.contains(pid),fields.count==2,let seconds=Double(fields[0]),let micros=Double(fields[1]),micros>=0,micros<1_000_000 else{return false}
        return seconds+micros/1_000_000>=earliest
    }
}

// Fixed launch policy. No caller-supplied commands, arguments, documents or URLs.
final class NativeApplicationLifecycle {
    let appID:String
    let appPath:String
    let enabled:Bool
    private var managed:ManagedApplicationIdentity?
    init(_ appID:String,_ appPath:String,_ enabled:Bool){self.appID=appID;self.appPath=appPath;self.enabled=enabled}
    private func approved(_ app:NSRunningApplication)->Bool {
        !app.isTerminated && app.bundleIdentifier==appID && app.executableURL?.resolvingSymlinksInPath().path==appPath && processStart(app.processIdentifier) != nil
    }
    private func running()->[NSRunningApplication] {NSWorkspace.shared.runningApplications.filter{approved($0)}}
    private func owned()->NSRunningApplication? {
        guard let identity=managed else{return nil}
        guard let app=NSRunningApplication(processIdentifier:identity.pid),!app.isTerminated,identity.matches(app.processIdentifier,processStart(app.processIdentifier)) else {managed=nil;return nil}
        // Launch Services may return the PID before AppKit has populated bundle
        // metadata. Keep the exact start-time identity, but do not authorize quit
        // until the executable path and bundle ID can also be verified.
        guard approved(app) else{return nil}
        return app
    }
    private func state(_ changed:Bool)->[String:Any] {
        let own=owned() != nil
        // NSWorkspace's application inventory can lag behind the launch callback.
        return ["running":own || !running().isEmpty,"managed":own,"changed":changed]
    }
    private func bundleURL()throws->URL {
        var url=URL(fileURLWithPath:appPath)
        for _ in 0..<8 {
            if url.pathExtension=="app" {
                guard let bundle=Bundle(url:url),bundle.bundleIdentifier==appID,bundle.executableURL?.resolvingSymlinksInPath().path==appPath else {throw fail("E_POLICY_DENIED")}
                return url
            }
            let parent=url.deletingLastPathComponent();if parent==url{break};url=parent
        }
        throw fail("E_POLICY_DENIED")
    }
    static func backgroundConfiguration()->NSWorkspace.OpenConfiguration {
        let config=NSWorkspace.OpenConfiguration()
        config.activates=false;config.hides=true;config.hidesOthers=false
        config.addsToRecentItems=false;config.promptsUserIfNeeded=false
        config.createsNewApplicationInstance=true;config.allowsRunningApplicationSubstitution=false
        return config
    }
    private func noEditedDocuments(_ app:NSRunningApplication)throws {
        var value:CFTypeRef?
        let status=AXUIElementCopyAttributeValue(AXUIElementCreateApplication(app.processIdentifier),kAXWindowsAttribute as CFString,&value)
        guard status == .success,let windows=value as? [AXUIElement],windows.count<=32 else {throw fail("E_POLICY_DENIED")}
        for window in windows {
            var edited:CFTypeRef?
            let read=AXUIElementCopyAttributeValue(window,"AXEdited" as CFString,&edited)
            if read == .success {guard let edited=edited as? NSNumber,!edited.boolValue else{throw fail("E_POLICY_DENIED")}}
            else if read != .attributeUnsupported && read != .noValue {throw fail("E_POLICY_DENIED")}
        }
    }
    func request(_ action:String,_ check:()throws->Void=({}))throws->[String:Any] {
        guard enabled else{throw fail("E_POLICY_DENIED")}
        guard ["status","launch","quit"].contains(action) else{throw fail("E_INVALID_ARGUMENT")}
        try InputCancellation.shared.check();try check()
        if action=="status" {return state(false)}
        if action=="launch" {
            if !running().isEmpty {return state(false)}
            let url=try bundleURL(),config=Self.backgroundConfiguration()
            let prior=Set(NSWorkspace.shared.runningApplications.map{$0.processIdentifier})
            let earliest=Date().timeIntervalSince1970
            var done=false,launched:NSRunningApplication?,launchError:Error?
            try InputCancellation.shared.check();try check()
            NSWorkspace.shared.openApplication(at:url,configuration:config){app,error in
                launched=app;launchError=error;done=true
                if let app,let started=processStart(app.processIdentifier) {
                    let identity=ManagedApplicationIdentity(pid:app.processIdentifier,started:started)
                    if identity.created(after:earliest,excluding:prior){self.managed=identity}
                }
            }
            let deadline=ProcessInfo.processInfo.systemUptime+3.5
            do {
                // The completion's retained NSRunningApplication may cache an
                // initial isFinishedLaunching=false (seen with Calculator).
                // Completion plus exact live process identity proves launch;
                // window discovery is a separate operation and may be empty.
                while !done {
                    try InputCancellation.shared.check()
                    guard ProcessInfo.processInfo.systemUptime<deadline else{throw fail("E_TIMEOUT",true)}
                    RunLoop.current.run(until:Date().addingTimeInterval(0.01))
                }
                guard launchError==nil,let app=launched else {throw fail("E_BACKEND_UNAVAILABLE",true)}
                while owned()==nil {
                    try InputCancellation.shared.check()
                    guard !app.isTerminated,ProcessInfo.processInfo.systemUptime<deadline else{throw fail("E_TIMEOUT",true)}
                    RunLoop.current.run(until:Date().addingTimeInterval(0.01))
                }
                try check();return state(true)
            }catch {let failure=error as? Failure ?? fail("E_INTERNAL");throw fail(failure.code,true)}
        }
        guard let app=owned() else {if running().isEmpty{return state(false)};throw fail("E_POLICY_DENIED")}
        // Never quit an instance currently used by the human, or discard edited documents.
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier else{throw fail("E_INTERFERENCE_RISK")}
        try noEditedDocuments(app);try InputCancellation.shared.check();try check()
        guard owned()?.processIdentifier==app.processIdentifier,app.terminate() else{throw fail("E_POLICY_DENIED")}
        let deadline=ProcessInfo.processInfo.systemUptime+3
        do {
            while approved(app) {
                try InputCancellation.shared.check()
                guard ProcessInfo.processInfo.systemUptime<deadline else{throw fail("E_TIMEOUT",true)}
                RunLoop.current.run(until:Date().addingTimeInterval(0.01))
            }
            managed=nil;try check();return state(true)
        }catch {let failure=error as? Failure ?? fail("E_INTERNAL");throw fail(failure.code,true)}
    }
}
