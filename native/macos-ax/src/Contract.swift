import ApplicationServices
import Foundation
import Darwin
struct Failure:Error {let code:String;var uncertain=false}
func fail(_ code:String,_ uncertain:Bool=false)->Failure {Failure(code:code,uncertain:uncertain)}

// Input metadata only. Never retain key codes, characters, flags or field values.
// An external event explains only its own kind of change. It is not permission
// for the automated application to acquire foreground/focus or post input.
let semanticInputTypes:[CGEventType]=[.mouseMoved,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged,.leftMouseDown,.rightMouseDown,.otherMouseDown,.keyDown,.flagsChanged]
func semanticInputKind(_ type:CGEventType)->(pointer:Bool,activation:Bool)?{
    switch type{
    case .mouseMoved,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged:return (true,false)
    case .leftMouseDown,.rightMouseDown,.otherMouseDown:return (true,true)
    case .keyDown,.flagsChanged:return (false,true)
    default:return nil
    }
}
struct SemanticInputEvent {
    let sequence:UInt64
    let time:TimeInterval
    let source:pid_t
    let point:CGPoint?
    let activation:Bool
}
struct SemanticInputCheckpoint {
    let sequence:UInt64
    let epoch:UInt64
    let time:TimeInterval
    let healthy:Bool
    func consumingPointer(_ sequence:UInt64)->SemanticInputCheckpoint{SemanticInputCheckpoint(sequence:max(self.sequence,sequence),epoch:epoch,time:time,healthy:healthy)}
}
struct SemanticInputHistory {
    private(set) var sequence:UInt64=0,epoch:UInt64=0
    private(set) var healthy=false
    private var events:[SemanticInputEvent]=[]
    private var next=0
    mutating func setHealthy(_ value:Bool){if value != healthy{epoch &+= 1};healthy=value;if !value{events.removeAll(keepingCapacity:true);next=0}}
    mutating func record(source:pid_t,point:CGPoint?,activation:Bool,time:TimeInterval){
        sequence &+= 1
        let event=SemanticInputEvent(sequence:sequence,time:time,source:source,point:point,activation:activation)
        if events.count<512{events.append(event)}else{events[next]=event;next=(next+1)%512}
    }
    func checkpoint(_ time:TimeInterval)->SemanticInputCheckpoint{SemanticInputCheckpoint(sequence:sequence,epoch:epoch,time:time,healthy:healthy)}
    func continuous(_ checkpoint:SemanticInputCheckpoint)->Bool{healthy && checkpoint.healthy && epoch==checkpoint.epoch}
    private func external(_ event:SemanticInputEvent,_ target:pid_t,_ own:pid_t)->Bool{event.source>=0 && event.source != target && event.source != own}
    func pointerEvidence(_ point:CGPoint,since checkpoint:SemanticInputCheckpoint,target:pid_t,own:pid_t,now:TimeInterval)->UInt64?{
        guard continuous(checkpoint) else{return nil}
        guard let event=events.filter({$0.sequence>checkpoint.sequence && $0.time>=checkpoint.time && $0.time<=now && $0.point != nil}).max(by:{$0.sequence<$1.sequence}),
              // AX IPC may block before the first post-dispatch sample. Keep
              // the latest unused event for the native call's bounded 5s window;
              // the checkpoint, sequence consumption and newest-point match
              // prevent older or already accepted motion from excusing a warp.
              now-event.time<=5,external(event,target,own),let observed=event.point,
              abs(observed.x-point.x)<=0.5,abs(observed.y-point.y)<=0.5 else{return nil}
        return event.sequence
    }
    func explainsPointer(_ point:CGPoint,since checkpoint:SemanticInputCheckpoint,target:pid_t,own:pid_t,now:TimeInterval)->Bool{
        pointerEvidence(point,since:checkpoint,target:target,own:own,now:now) != nil
    }
    func explainsActivation(since checkpoint:SemanticInputCheckpoint,target:pid_t,own:pid_t,now:TimeInterval)->Bool{
        guard continuous(checkpoint) else{return false}
        return events.contains{event in event.activation && event.time>=checkpoint.time-0.25 && event.time<=now && now-event.time<=0.25 && external(event,target,own)}
    }
}
// Avoid pairing a cursor position sampled before an input event with history
// sampled after it. Re-sample reads only; never repeat the AX mutation.
func coherentSemanticCursor(history:()->SemanticInputHistory,point:()->CGPoint?)->(point:CGPoint,history:SemanticInputHistory)?{
    for _ in 0..<4{
        let before=history();guard let current=point() else{return nil};let after=history()
        if before.sequence==after.sequence && before.epoch==after.epoch && before.healthy==after.healthy{return (current,after)}
    }
    return nil
}
// AX failure remains explicit. A transient foreign-application read during an
// observed user activation is different from an empty/unsupported focus value.
enum SemanticFocusRead {case known,transient,denied}
func permitsSemanticChange(beforePID:pid_t,afterPID:pid_t,target:pid_t,own:pid_t,beforeFocus:SemanticFocusRead,afterFocus:SemanticFocusRead,focusEqual:Bool,beforePoint:CGPoint,afterPoint:CGPoint,history:SemanticInputHistory,checkpoint:SemanticInputCheckpoint,now:TimeInterval)->Bool{
    guard beforeFocus != .denied,afterFocus != .denied else{return false}
    // Human activity never excuses the target taking over another app.
    guard beforePID==target || afterPID != target else{return false}
    let focusChanged=beforePID != afterPID || beforeFocus != .known || afterFocus != .known || !focusEqual
    if focusChanged {
        guard afterPID != target,history.explainsActivation(since:checkpoint,target:target,own:own,now:now) else{return false}
    }
    if beforePoint != afterPoint {
        guard history.explainsPointer(afterPoint,since:checkpoint,target:target,own:own,now:now) else{return false}
    }
    return true
}
struct Probe {
    let pid:pid_t
    let focusedApp:AXUIElement?
    let focusedWindow:AXUIElement?
    let focused:AXUIElement?
    let point:CGPoint
    static func equal(_ a:AXUIElement?,_ b:AXUIElement?) -> Bool {
        switch (a,b) { case (nil,nil):return true; case(let a?,let b?):return CFEqual(a,b);default:return false }
    }
    func matches(_ b:Probe)->Bool { pid==b.pid && point==b.point && Self.equal(focusedApp,b.focusedApp) && Self.equal(focusedWindow,b.focusedWindow) && Self.equal(focused,b.focused) }
}
struct SemanticProbe {let state:Probe;let focusRead:SemanticFocusRead}
struct SemanticGuardState {
    private(set) var anchor:SemanticProbe
    private(set) var checkpoint:SemanticInputCheckpoint
    let target:pid_t,own:pid_t
    mutating func accept(_ after:SemanticProbe,history:SemanticInputHistory,now:TimeInterval)->Bool{
        let before=anchor
        guard permitsSemanticChange(beforePID:before.state.pid,afterPID:after.state.pid,target:target,own:own,beforeFocus:before.focusRead,afterFocus:after.focusRead,focusEqual:Probe.equal(before.state.focusedApp,after.state.focusedApp) && Probe.equal(before.state.focusedWindow,after.state.focusedWindow) && Probe.equal(before.state.focused,after.state.focused),beforePoint:before.state.point,afterPoint:after.state.point,history:history,checkpoint:checkpoint,now:now) else{return false}
        if before.state.point != after.state.point {
            guard let evidence=history.pointerEvidence(after.state.point,since:checkpoint,target:target,own:own,now:now) else{return false}
            checkpoint=checkpoint.consumingPointer(evidence)
        }
        anchor=after
        return true
    }
}

let secretLabels = try! NSRegularExpression(pattern:#"(?:^|[^a-z0-9])(?:password|passwd|pwd|passcode|secret|token|api[ _-]*key|access[ _-]*(?:key|token)|refresh[ _-]*token|private[ _-]*key|key|credentials?|authorization|auth|bearer|otp|cvv|cvc|session(?:[ _-]*id)?|cookie|pin|ssn|one[ _-]*time(?:[ _-]*(?:password|code))?|credit[ _-]*card|card[ _-]*number|cc[ _-]*(?:number|csc))(?=$|[^a-z0-9])|パスワード|暗証番号|認証(?:コード|情報|トークン|キー)|ワンタイム(?:パスワード|コード)|秘密鍵|秘密キー|シークレット|アクセストークン|APIキー"#,options:.caseInsensitive)
func secretLabel(_ s:String)->Bool {
    let normalized=s.precomposedStringWithCompatibilityMapping.replacingOccurrences(of:#"([A-Z])([A-Z][a-z])"#,with:"$1 $2",options:.regularExpression).replacingOccurrences(of:#"([a-z0-9])([A-Z])"#,with:"$1 $2",options:.regularExpression).replacingOccurrences(of:#"([A-Za-z])([0-9])"#,with:"$1 $2",options:.regularExpression).replacingOccurrences(of:#"([0-9])([A-Za-z])"#,with:"$1 $2",options:.regularExpression)
    return secretLabels.firstMatch(in:normalized,range:NSRange(normalized.startIndex...,in:normalized)) != nil
}

// The stdin reader and main-thread broker share this bounded FIFO. Every field,
// including the active request count and scheduling state, is guarded by lock.
final class NativeRequestQueue: @unchecked Sendable {
    private let lock=NSLock()
    private var requests:[(Data,Bool)]=[]
    private var count=0,draining=false,closed=false
    func enqueue(_ data:Data,_ tooLong:Bool)->(accepted:Bool,schedule:Bool) {
        lock.lock();defer{lock.unlock()}
        guard !closed,count<64 else{return (false,false)}
        requests.append((data,tooLong));count+=1
        let schedule = !draining;draining=true
        return (true,schedule)
    }
    func take()->(request:(Data,Bool)?,closed:Bool) {
        lock.lock();defer{lock.unlock()}
        guard !requests.isEmpty else{draining=false;return (nil,closed)}
        return (requests.removeFirst(),closed)
    }
    func finish()->(more:Bool,closed:Bool) {
        lock.lock();defer{lock.unlock()}
        count-=1;let more = !requests.isEmpty
        if !more{draining=false}
        return (more,closed)
    }
    func close()->Bool {
        lock.lock();defer{lock.unlock()}
        closed=true;let schedule = !draining;draining=true
        return schedule
    }
}
// Optional means an explicit unsupported/noValue result, never a transport/permission error.
func decodeAttribute(_ status:AXError,_ value:CFTypeRef?,_ optional:Bool) throws -> CFTypeRef? {
    if status == .success {guard let value else {throw fail("E_TARGET_NOT_FOUND")};return value}
    if optional && (status == .attributeUnsupported || status == .noValue) {return nil}
    throw fail("E_TARGET_NOT_FOUND")
}
func boundedString(_ value:CFTypeRef?,_ cap:Int) throws -> String {
    guard let value else{return ""};guard let result=value as? String else {throw fail("E_TARGET_NOT_FOUND")}
    guard result.utf8.count<=cap,result.utf16.count<=cap else {throw fail("E_RESOURCE_LIMIT")};return result
}

// Some SwiftUI toolbar buttons return AXError.failure for their absent subrole.
// Keep those controls observable but inert; never reinterpret permission,
// transport, stale-element or secure-text failures as an empty safety attribute.
func observedSubrole(_ status:AXError,_ value:CFTypeRef?,_ role:String) throws -> (String,Bool) {
    if status == .failure && role == kAXButtonRole && value == nil {return ("",false)}
    return (try boundedString(try decodeAttribute(status,value,true),100),true)
}

func inertLayoutGroup(role:String,subrole:String,identifier:String,name:String,value:String,enabled:Bool,hasSelected:Bool)->Bool {
    role==kAXGroupRole && subrole.isEmpty && identifier.isEmpty && name.isEmpty && value.isEmpty && !enabled && !hasSelected
}

struct Rule { let role: String; let subrole: String?; let allowed: Set<String> }

func processStart(_ pid:pid_t)->String? {
    var info=proc_bsdinfo();let size=Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,size)==size else{return nil}
    return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}
