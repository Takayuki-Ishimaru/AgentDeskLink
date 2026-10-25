// Window pixels are an explicit, separate opt-in. Never map AXWindow to CGWindowID by title or geometry.
import AppKit
import ApplicationServices
import CryptoKit
import Darwin
import Foundation
import ScreenCaptureKit

let nativeCaptureMaxPNGBytes = 8 * 1024 * 1024
let nativeCaptureMaxResponseBytes = 12 * 1024 * 1024
let nativeCaptureMaxPixels = 4_194_304
let nativeCaptureMaxDimension = 4096

func captureDigest(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "" }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
func captureProcessStart(_ pid: pid_t) -> String? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}
func captureDimensions(_ frame: CGRect, _ scale: CGFloat) throws -> (width: Int, height: Int) {
    guard frame.origin.x.isFinite, frame.origin.y.isFinite, frame.width.isFinite, frame.height.isFinite,
          frame.size.width > 0, frame.size.height > 0, scale.isFinite, scale > 0 else { throw fail("E_TARGET_NOT_FOUND") }
    let width = frame.width * scale, height = frame.height * scale
    guard width.isFinite, height.isFinite else { throw fail("E_RESOURCE_LIMIT") }
    let ratio = min(1, CGFloat(nativeCaptureMaxDimension) / width, CGFloat(nativeCaptureMaxDimension) / height,
                    sqrt(CGFloat(nativeCaptureMaxPixels) / width / height))
    let w = max(1, Int(floor(width * ratio))), h = max(1, Int(floor(height * ratio)))
    guard w <= nativeCaptureMaxDimension, h <= nativeCaptureMaxDimension, w * h <= nativeCaptureMaxPixels else { throw fail("E_RESOURCE_LIMIT") }
    return (w, h)
}

// A timeout cannot publish a late completion. No nested request is dispatched while the reader waits.
private final class CaptureCompletion<T> {
    private let lock = NSLock()
    private var result: Result<T, Error>?
    private var expired = false
    func finish(_ value: Result<T, Error>) { lock.lock(); defer { lock.unlock() }; if !expired && result == nil { result = value } }
    func take() -> Result<T, Error>? { lock.lock(); defer { lock.unlock() }; return result }
    func expire() { lock.lock(); expired = true; result = nil; lock.unlock() }
}
func waitForCapture<T>(_ timeout: TimeInterval = 1.5, _ start: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
    let completion = CaptureCompletion<T>()
    start { completion.finish($0) }
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if let result = completion.take() { return try result.get() }
        RunLoop.current.run(until: min(deadline, Date().addingTimeInterval(0.005)))
    } while Date() < deadline
    completion.expire()
    throw fail("E_TIMEOUT")
}

struct CaptureWindow {
    let windowID: CGWindowID
    let pid: pid_t
    let started: String
    let bundleID: String
    let title: String
    let frame: CGRect
    let onScreen: Bool
    let layer: Int
    let native: SCWindow?
    var identity: String { "\(windowID):\(pid):\(started)" }
    var epoch: String {
        captureDigest(["identity": identity, "x": frame.minX, "y": frame.minY,
                       "width": frame.width, "height": frame.height, "on_screen": onScreen])
    }
}
protocol WindowCaptureSource {
    func windows() throws -> [CaptureWindow]
    func image(_ window: CaptureWindow) throws -> CGImage
}
final class ScreenCaptureSource: WindowCaptureSource {
    func windows() throws -> [CaptureWindow] {
        let content: SCShareableContent = try waitForCapture { done in
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, error in
                if let content, error == nil { done(.success(content)) } else { done(.failure(fail("E_BACKEND_UNAVAILABLE"))) }
            }
        }
        return content.windows.compactMap { window in
            guard let app = window.owningApplication, let started = captureProcessStart(app.processID) else { return nil }
            return CaptureWindow(windowID: window.windowID, pid: app.processID, started: started, bundleID: app.bundleIdentifier,
                                 title: window.title ?? "", frame: window.frame, onScreen: window.isOnScreen, layer: window.windowLayer, native: window)
        }
    }
    func image(_ window: CaptureWindow) throws -> CGImage {
        guard let native = window.native else { throw fail("E_TARGET_NOT_FOUND") }
        let filter = SCContentFilter(desktopIndependentWindow: native)
        let dimensions = try captureDimensions(window.frame, CGFloat(filter.pointPixelScale))
        let config = SCStreamConfiguration()
        config.width = dimensions.width; config.height = dimensions.height
        config.showsCursor = false; config.ignoreShadowsSingleWindow = true
        config.shouldBeOpaque = true; config.scalesToFit = true
        config.capturesAudio = false
        // macOS14 defaults exclude child windows. Explicitly preserve this on newer systems.
        if #available(macOS 14.2, *) { config.includeChildWindows = false }
        return try waitForCapture { done in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                if let image, error == nil { done(.success(image)) } else { done(.failure(fail("E_BACKEND_UNAVAILABLE"))) }
            }
        }
    }
}
final class CaptureTarget {
    let id = "t_" + UUID().uuidString
    let identity: String
    var window: CaptureWindow
    var retired = false
    init(_ window: CaptureWindow) { identity = window.identity; self.window = window }
}
final class CaptureSession {
    let id = "s_" + UUID().uuidString
    let target: CaptureTarget
    var revision = 0
    var epoch = ""
    var interactive:NativeInteractiveSession?
    init(_ target: CaptureTarget) { self.target = target }
}
final class WindowCaptureBroker {
    var input:NativeInteractiveCoordinator?
    let enabled: Bool
    let allowAll:Bool
    let appID: String
    let appPath: String
    private let source: WindowCaptureSource
    private let permission: () -> Bool
    private let approve: (CaptureWindow) -> Bool
    private var targets: [CaptureTarget] = []
    private var sessions: [String: CaptureSession] = [:]
    init(_ appID: String, _ appPath: String, _ enabled: Bool,
         allowAll:Bool=false, source: WindowCaptureSource = ScreenCaptureSource(), permission: @escaping () -> Bool = CGPreflightScreenCaptureAccess,
         approve: ((CaptureWindow) -> Bool)? = nil) {
        self.allowAll=allowAll;self.appID = appID; self.appPath = appPath; self.enabled = enabled; self.source = source; self.permission = permission
        self.approve = approve ?? { window in
            guard let app = NSRunningApplication(processIdentifier: window.pid), !app.isTerminated else { return false }
            return (allowAll ? app.activationPolicy == .regular && app.bundleIdentifier == window.bundleID : app.bundleIdentifier == appID && window.bundleID == appID && app.executableURL?.resolvingSymlinksInPath().path == appPath) && captureProcessStart(window.pid) == window.started
        }
    }
    var available: Bool { enabled && permission() }
    func checkPermission() throws { guard enabled else { throw fail("E_POLICY_DENIED") }; guard permission() else { throw fail("E_BACKEND_UNAVAILABLE") } }
    func owns(_ targetID: String) -> Bool { targets.contains { $0.id == targetID } }
    private func permittedWindows() throws -> [CaptureWindow] {
        try checkPermission()
        return try source.windows().filter { (allowAll || $0.bundleID == appID) && $0.layer == 0 && approve($0) }
    }
    private func retireUnlisted(_ windows: [CaptureWindow]) {
        let identities = Set(windows.map { $0.identity })
        for target in targets where !identities.contains(target.identity) { target.retired = true }
    }
    func discover() throws -> [[String: Any]] {
        // Disabled/unpermitted visual capture never invokes SCShareableContent or an OS permission request.
        guard available else { return [] }
        let windows = try permittedWindows()
        guard windows.count <= 32 else { throw fail("E_RESOURCE_LIMIT") }
        retireUnlisted(windows)
        let retained = Set(sessions.values.map { ObjectIdentifier($0.target) })
        targets.removeAll { $0.retired && !retained.contains(ObjectIdentifier($0)) }
        var found: [CaptureTarget] = []
        for window in windows {
            _ = try captureDimensions(window.frame, 1)
            if let old = targets.first(where: { !$0.retired && $0.identity == window.identity }) { old.window = window; found.append(old) }
            else {
                guard targets.count < 256 else { throw fail("E_RESOURCE_LIMIT") }
                let target = CaptureTarget(window); targets.append(target); found.append(target)
            }
        }
        return found.map { metadata($0) }
    }
    private func metadata(_ target: CaptureTarget) -> [String: Any] {
        let r = target.window.frame
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        let ids = NSScreen.screens.compactMap { screen -> String? in
            let f = screen.frame, screenRect = CGRect(x: screen.frame.minX, y: primaryTop - screen.frame.maxY, width: f.width, height: f.height)
            guard r.intersects(screenRect), let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
            return "display_\(id)"
        }
        // No AX attributes are associated with this target. Parent applies configured static pixel masks.
        return ["target_id": target.id, "application_id": appID, "capture_only": true, "label": "Window image", "interactive_input":input?.available ?? false, "gesture_backends":input?.backends ?? [],
                "window": ["bounds": ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height,
                                       "coordinate_space": "desktop_points_top_left"], "display_ids": ids, "minimized": !target.window.onScreen]]
    }
    private func validate(_ target: CaptureTarget) throws -> CaptureWindow {
        try checkPermission()
        guard !target.retired else { throw fail("E_TARGET_NOT_FOUND") }
        let windows = try permittedWindows(); retireUnlisted(windows)
        guard !target.retired, let current = windows.first(where: { $0.identity == target.identity }) else { target.retired = true; throw fail("E_TARGET_NOT_FOUND") }
        _ = try captureDimensions(current.frame, 1)
        guard current.onScreen else { throw fail("E_UNSUPPORTED_ACTION") }
        target.window = current; return current
    }
    func request(_ op: String, _ request: [String: Any], _ targetID: String) throws -> [String: Any] {
        guard let target = targets.first(where: { $0.id == targetID }) else { throw fail("E_TARGET_NOT_FOUND") }
        if op == "open" {
            guard let mode=request["mode"] as? String,["background_semantic","interactive_desktop"].contains(mode) else { throw fail("E_INTERFERENCE_RISK") }
            let window = try validate(target)
            guard sessions.count < 32 else { throw fail("E_RESOURCE_LIMIT") }
            let session = CaptureSession(target)
            if mode=="interactive_desktop"{guard let input else{throw fail("E_INTERFERENCE_RISK")};session.interactive=try input.open(window)}
            sessions[session.id] = session; return ["session_id": session.id]
        }
        guard let sid = request["session_id"] as? String, let session = sessions[sid], session.target === target else { throw fail("E_TARGET_NOT_FOUND") }
        // Close remains available after permission revocation or target destruction.
        if op == "close" { if let interactive=session.interactive{try input?.close(interactive)};sessions.removeValue(forKey: sid); return ["closed": true] }
        guard session.interactive?.poisoned != true else{throw fail("E_TARGET_NOT_FOUND")}
        let window = try validate(target)
        if op == "snapshot" {
            if session.epoch != window.epoch { session.revision += 1; session.epoch = window.epoch }
            return ["revision": session.revision, "elements": [], "truncated": false, "surface_epoch": window.epoch]
        }
        if ["gesture","prepare_input","commit_input"].contains(op){
            guard let interactive=session.interactive,let input else{throw fail("E_INTERFERENCE_RISK")}
            if op=="gesture"{return try input.gesture(interactive,request,session.revision)}
            if op=="prepare_input"{return try input.prepare(interactive,request)}
            return try input.commit(interactive,request)
        }
        guard op == "capture" else { throw fail("E_UNSUPPORTED_ACTION") }
        let image = try source.image(window)
        guard image.width > 0, image.height > 0, image.width <= nativeCaptureMaxDimension, image.height <= nativeCaptureMaxDimension,
              image.width * image.height <= nativeCaptureMaxPixels else { throw fail("E_RESOURCE_LIMIT") }
        let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        let capturedAt = formatter.string(from: Date())
        let current = try validate(target)
        guard current.epoch == window.epoch else { throw fail("E_STALE_STATE") }
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), png.count <= nativeCaptureMaxPNGBytes else { throw fail("E_RESOURCE_LIMIT") }
        // Validate again after encoding. Never publish pixels after permission revocation/target loss.
        guard try validate(target).epoch == window.epoch else { throw fail("E_STALE_STATE") }
        var result:[String:Any] = ["png_base64": png.base64EncodedString(), "captured_at": capturedAt, "coordinate_space": "window_pixels",
                "viewport": ["width": image.width, "height": image.height, "scroll_x": 0, "scroll_y": 0,
                             "device_scale_factor": Double(image.width) / window.frame.width],
                "source_to_desktop": ["origin_x": window.frame.minX, "origin_y": window.frame.minY,
                                      "scale_x": window.frame.width / Double(image.width), "scale_y": window.frame.height / Double(image.height),
                                      "coordinate_space": "desktop_points_top_left"],
                "surface_epoch": window.epoch, "redacted": false]
        if let interactive=session.interactive,let input{result["input_token"]=try input.captured(interactive,window,image.width,image.height)}
        return result
    }
}
