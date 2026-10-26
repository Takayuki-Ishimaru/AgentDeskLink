import AppKit
import ApplicationServices
import Darwin
import Foundation

alarm(20)
var failures = 0, count = 0
func test(_ name: String, _ body: () throws -> Void) { count += 1; do { try body(); print("PASS \(name)") } catch { failures += 1; print("FAIL \(name): \(error)") } }
func require(_ condition: Bool) throws { if !condition { throw fail("TEST_FAILED") } }
func denied(_ code: String, _ body: () throws -> Void) throws {
    do { try body() } catch let error as Failure { try require(error.code == code); return }
    throw fail("EXPECTED_FAILURE_\(code)")
}
func window(_ id: UInt32 = 11, pid: pid_t = 123, start: String = "100:1", frame: CGRect = CGRect(x: -30, y: 12, width: 8, height: 4), onScreen: Bool = true, bundleID: String = "test.fixture", layer: Int = 0) -> CaptureWindow {
    CaptureWindow(windowID: id, pid: pid, started: start, bundleID: bundleID, title: "Same title", frame: frame, onScreen: onScreen, layer: layer, native: nil)
}
func fixtureImage(_ width: Int = 4, _ height: Int = 2) -> CGImage {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.9, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()!
}
func noisyImage(_ width: Int, _ height: Int) -> CGImage {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let pixels = context.data!.assumingMemoryBound(to: UInt8.self)
    var random: UInt32 = 47
    for i in 0..<(width * height) {
        for channel in 0..<3 { random = random &* 1_664_525 &+ 1_013_904_223; pixels[i * 4 + channel] = UInt8(random >> 24) }
        pixels[i * 4 + 3] = 255
    }
    return context.makeImage()!
}
final class FakeSource: WindowCaptureSource {
    var items = [window()], calls = 0, images = 0
    var afterImage: (() -> Void)?, beforeWindows: (() -> Void)?
    var imageWidth = 4, imageHeight = 2
    var noisy = false
    var capturedID: UInt32?
    func windows() throws -> [CaptureWindow] { calls += 1; beforeWindows?(); return items }
    func image(_ window: CaptureWindow) throws -> CGImage { images += 1; capturedID = window.windowID; afterImage?(); return noisy ? noisyImage(imageWidth, imageHeight) : fixtureImage(imageWidth, imageHeight) }
}
func broker(_ source: FakeSource, enabled: Bool = true, permission: @escaping () -> Bool = { true }, approved: @escaping (CaptureWindow) -> Bool = { _ in true }) -> WindowCaptureBroker {
    WindowCaptureBroker("test.fixture", "/fixture", enabled, source: source, permission: permission, approve: approved)
}
func opened(_ broker: WindowCaptureBroker, index: Int = 0) throws -> (String, String) {
    let targets = try broker.discover(), id = targets[index]["target_id"] as! String
    let result = try broker.request("open", ["mode": "background_semantic"], id)
    return (id, result["session_id"] as! String)
}
func request(_ sid: String) -> [String: Any] { ["session_id": sid] }

test("disabled capture neither probes permission nor enumerates pixels") {
    let source = FakeSource(); var probes = 0
    let capture = broker(source, enabled: false, permission: { probes += 1; return true })
    try require(try capture.discover().isEmpty); try require(!capture.available && probes == 0 && source.calls == 0 && source.images == 0)
    try denied("E_POLICY_DENIED") { try capture.checkPermission() }
}
test("denied existing permission never invokes source or OS permission request") {
    let source = FakeSource(), capture = broker(source, permission: { false })
    try require(try capture.discover().isEmpty); try require(!capture.available && source.calls == 0)
    try denied("E_BACKEND_UNAVAILABLE") { try capture.checkPermission() }
}
test("dimension bounds preserve aspect ratio and negative desktop origins") {
    let full = try captureDimensions(CGRect(x: -40, y: -20, width: 800, height: 400), 2)
    try require(full.width == 1600 && full.height == 800)
    let large = try captureDimensions(CGRect(x: 0, y: 0, width: 10_000, height: 10_000), 2)
    try require(large.width == 2048 && large.height == 2048)
    let wide = try captureDimensions(CGRect(x: 0, y: 0, width: 50_000, height: 1), 1)
    try require(wide.width == 4096 && wide.height == 1)
    for frame in [CGRect(x: 0, y: 0, width: 0, height: 3), CGRect(x: CGFloat.infinity, y: 0, width: 3, height: 3)] {
        try denied("E_TARGET_NOT_FOUND") { _ = try captureDimensions(frame, 1) }
    }
    try denied("E_TARGET_NOT_FOUND") { _ = try captureDimensions(CGRect(x: 0, y: 0, width: 3, height: 3), 0) }
}
test("same title and geometry remain distinct exact-window capture targets") {
    let source = FakeSource(); source.items = [window(11), window(12)]
    let capture = broker(source), targets = try capture.discover()
    try require(targets.count == 2 && targets[0]["target_id"] as? String != targets[1]["target_id"] as? String)
    try require(targets.allSatisfy { $0["capture_only"] as? Bool == true })
    let (id, sid) = try opened(capture, index: 1)
    _ = try capture.request("capture", request(sid), id)
    try require(source.capturedID == 12)
}
test("capture snapshots contain no inferred AX semantics and have stable geometry epoch") {
    let source = FakeSource(), capture = broker(source), (id, sid) = try opened(capture)
    let first = try capture.request("snapshot", request(sid), id), second = try capture.request("snapshot", request(sid), id)
    try require((first["elements"] as? [Any])?.isEmpty == true && first["truncated"] as? Bool == false)
    try require(first["revision"] as? Int == second["revision"] as? Int && first["surface_epoch"] as? String == second["surface_epoch"] as? String)
    source.items = [window(frame: CGRect(x: -29, y: 12, width: 8, height: 4))]
    let moved = try capture.request("snapshot", request(sid), id)
    try require(moved["revision"] as? Int == 2 && moved["surface_epoch"] as? String != first["surface_epoch"] as? String)
}
test("PNG transport has exact dimensions, timestamp and per-axis desktop transform") {
    let source = FakeSource(), capture = broker(source), (id, sid) = try opened(capture)
    let raw = try capture.request("capture", request(sid), id)
    let result = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: raw)) as! [String: Any]
    let png = Data(base64Encoded: result["png_base64"] as! String)!, bitmap = NSBitmapImageRep(data: png)!
    let viewport = result["viewport"] as! [String: Any], transform = result["source_to_desktop"] as! [String: Any]
    try require(bitmap.pixelsWide == 4 && bitmap.pixelsHigh == 2 && png.count <= nativeCaptureMaxPNGBytes)
    try require(result["coordinate_space"] as? String == "window_pixels" && result["redacted"] as? Bool == false)
    try require(viewport["width"] as? Int == 4 && viewport["height"] as? Int == 2 && viewport["device_scale_factor"] as? Double == 0.5)
    try require(transform["origin_x"] as? Double == -30 && transform["scale_x"] as? Double == 2 && transform["scale_y"] as? Double == 2)
    let formatter=ISO8601DateFormatter();formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
    try require(transform["coordinate_space"] as? String == "desktop_points_top_left" && formatter.date(from: result["captured_at"] as! String) != nil)
}
test("closed or replaced exact window cannot reconnect even with same title geometry and PID") {
    let source = FakeSource(), capture = broker(source), (id, sid) = try opened(capture)
    source.items = [window(12)]
    try denied("E_TARGET_NOT_FOUND") { _ = try capture.request("capture", request(sid), id) }
    source.items = [window(11)]
    try denied("E_TARGET_NOT_FOUND") { _ = try capture.request("snapshot", request(sid), id) }
    let replacement = try capture.discover()
    try require(replacement.first?["target_id"] as? String != id)
    try require(try capture.request("close", request(sid), id)["closed"] as? Bool == true)
}
test("PID reuse or execution identity mismatch retires target") {
    let source = FakeSource(), capture = broker(source), (id, sid) = try opened(capture)
    source.items = [window(start: "200:2")]
    try denied("E_TARGET_NOT_FOUND") { _ = try capture.request("capture", request(sid), id) }
    let deniedSource = FakeSource(), deniedBroker = broker(deniedSource, approved: { _ in false })
    try require(try deniedBroker.discover().isEmpty)
}
test("foreign apps and non-window layers never enter capture discovery") {
    let source = FakeSource(); source.items = [window(bundleID: "other.app"), window(12, layer: 2)]
    try require(try broker(source).discover().isEmpty)
}
test("permission loss after pixels are captured suppresses output and still allows close") {
    let source = FakeSource(); var permission = true
    let capture = broker(source, permission: { permission }), (id, sid) = try opened(capture)
    source.afterImage = { permission = false }
    try denied("E_BACKEND_UNAVAILABLE") { _ = try capture.request("capture", request(sid), id) }
    try require(try capture.request("close", request(sid), id)["closed"] as? Bool == true)
}
test("geometry change or window loss during capture suppresses stale pixels") {
    for loss in [false, true] {
        let source = FakeSource(), capture = broker(source), (id, sid) = try opened(capture)
        source.afterImage = { source.items = loss ? [] : [window(frame: CGRect(x: 20, y: 20, width: 8, height: 4))] }
        try denied(loss ? "E_TARGET_NOT_FOUND" : "E_STALE_STATE") { _ = try capture.request("capture", request(sid), id) }
    }
}
test("minimized or offscreen windows and physical input operations are rejected") {
    let source = FakeSource(), capture = broker(source), (id, sid) = try opened(capture)
    source.items = [window(onScreen: false)]
    try denied("E_UNSUPPORTED_ACTION") { _ = try capture.request("capture", request(sid), id) }
    source.items = [window()]
    try denied("E_UNSUPPORTED_ACTION") { _ = try capture.request("act", request(sid), id) }
    try denied("E_INTERFERENCE_RISK") { _ = try capture.request("open", ["mode": "strict_isolated"], id) }
}
test("session must belong to the exact capture target") {
    let source = FakeSource(); source.items = [window(11), window(12)]
    let capture = broker(source), (first, sid) = try opened(capture), targets = try capture.discover()
    let other = targets.first { $0["target_id"] as? String != first }!["target_id"] as! String
    try denied("E_TARGET_NOT_FOUND") { _ = try capture.request("capture", request(sid), other) }
    try denied("E_TARGET_NOT_FOUND") { _ = try capture.request("capture", [:], first) }
}
test("oversized provider image is rejected before PNG encoding") {
    let source = FakeSource(), capture = broker(source), (id, sid) = try opened(capture)
    source.imageWidth = 4097; source.imageHeight = 1
    try denied("E_RESOURCE_LIMIT") { _ = try capture.request("capture", request(sid), id) }
}
test("oversized pixel count and incompressible PNG byte budget are both rejected") {
    for noisy in [false, true] {
        let source = FakeSource(), capture = broker(source), (id, sid) = try opened(capture)
        source.imageWidth = noisy ? 2048 : 3000; source.imageHeight = noisy ? 2048 : 2000; source.noisy = noisy
        try denied("E_RESOURCE_LIMIT") { _ = try capture.request("capture", request(sid), id) }
    }
}
test("timed out callback cannot affect a later observation") {
    var late: ((Result<Int, Error>) -> Void)?
    try denied("E_TIMEOUT") { let _: Int = try waitForCapture(0.01) { late = $0 } }
    late?(.success(100))
    let current: Int = try waitForCapture(0.1) { $0(.success(7)) }
    try require(current == 7)
}
test("trusted broad capture permits multiple apps and still rejects non-window layers") {
    let source=FakeSource()
    source.items=[window(11,bundleID:"one.app"),window(12,bundleID:"two.app"),window(13,bundleID:"two.app",layer:1)]
    let strict=WindowCaptureBroker("one.app","/fixture",true,source:source,permission:{true},approve:{_ in true})
    try require(try strict.discover().count==1)
    let broad=WindowCaptureBroker("*","/fixture",true,allowAll:true,source:source,permission:{true},approve:{_ in true})
    let targets=try broad.discover();try require(targets.count==2)
    try require(Set(targets.map{$0["target_id"] as! String}).count==2)
}
test("broad operations can retain the configured capture app boundary") {
    let source=FakeSource();source.items=[window(11,bundleID:"one.app"),window(12,bundleID:"two.app")]
    let capture=WindowCaptureBroker("one.app","/fixture",true,allowAll:true,restrictTargets:true,source:source,permission:{true},approve:{_ in true})
    try require(try capture.discover().count==1)
}
print("\(count - failures)/\(count) capture tests passed")
exit(failures == 0 ? 0 : 1)
