import ApplicationServices
import Foundation
var failures=0,checks=0
func test(_ name:String,_ body:() throws->Void){checks+=1;do{try body();print("PASS \(name)")}catch{failures+=1;print("FAIL \(name): \(error)")}}
func require(_ condition:Bool) throws {if !condition {throw fail("TEST_FAILED")}}
func denied(_ body:() throws->Void) throws {do{try body()}catch is Failure{return};throw fail("EXPECTED_FAILURE")}
for status in [AXError.cannotComplete,.apiDisabled,.invalidUIElement] {test("failed optional safety attribute status \(status.rawValue) denied"){try denied{_ = try decodeAttribute(status,"" as CFString,true)}}}
test("explicit optional unsupported or noValue accepted"){try require(try decodeAttribute(.attributeUnsupported,nil,true)==nil);try require(try decodeAttribute(.noValue,nil,true)==nil)}
test("required read failure cannot masquerade as empty fill readback"){try denied{_ = try boundedString(try decodeAttribute(.cannotComplete,nil,false),4096)};try denied{_ = try decodeAttribute(.noValue,nil,false)}}
test("successful empty string is a real empty readback"){try require(try boundedString(try decodeAttribute(.success,"" as CFString,false),4096)=="")}
test("successful missing or wrong-type attribute denied"){try denied{_ = try decodeAttribute(.success,nil,true)};try denied{_ = try boundedString(NSNumber(value:1),100)}}
test("raw identity and Unicode safety data bounded before processing"){try denied{_ = try boundedString(String(repeating:"a",count:513) as CFString,512)};try denied{_ = try boundedString(String(repeating:"界",count:200) as CFString,512)};try require(try boundedString("AXTextField" as CFString,100)=="AXTextField")}
test("only empty disabled unselected AXGroup chrome is omitted"){
    try require(inertLayoutGroup(role:kAXGroupRole,subrole:"",identifier:"",name:"",value:"",enabled:false,hasSelected:false))
    for role in [kAXButtonRole,"AXUnknown"] {try require(!inertLayoutGroup(role:role,subrole:"",identifier:"",name:"",value:"",enabled:false,hasSelected:false))}
    for variant in 0..<6 {try require(!inertLayoutGroup(role:kAXGroupRole,subrole:variant==0 ? "Meaningful" : "",identifier:variant==1 ? "control" : "",name:variant==2 ? "Label" : "",value:variant==3 ? "State" : "",enabled:variant==4,hasSelected:variant==5))}
}
test("SwiftUI buttons with failed optional subrole stay observable but cannot act"){
    let (subrole,known)=try observedSubrole(.failure,nil,kAXButtonRole)
    try require(subrole.isEmpty && !known)
    let (_,supported)=try observedSubrole(.attributeUnsupported,nil,kAXButtonRole)
    try require(supported)
}
test("subrole permission and stale failures remain fatal for every role"){
    for role in [kAXButtonRole,kAXTextFieldRole,kAXTextAreaRole] {
        for status in [AXError.cannotComplete,.apiDisabled,.invalidUIElement] {try denied{_ = try observedSubrole(status,nil,role)}}
    }
    for role in [kAXTextFieldRole,kAXTextAreaRole] {try denied{_ = try observedSubrole(.failure,nil,role)}}
    try denied{_ = try observedSubrole(.success,NSNumber(value:1),kAXButtonRole)}
}
test("request queue preserves FIFO metadata and schedules only one drain"){
    let queue=NativeRequestQueue()
    let first=queue.enqueue(Data([1]),false),second=queue.enqueue(Data([2]),true)
    try require(first.accepted && first.schedule && second.accepted && !second.schedule)
    let a=queue.take();try require(a.request?.0==Data([1]) && a.request?.1==false && !a.closed)
    try require(queue.finish().more)
    let b=queue.take();try require(b.request?.0==Data([2]) && b.request?.1==true)
    try require(!queue.finish().more && queue.take().request==nil)
    try require(queue.enqueue(Data([3]),false).schedule)
}
test("request queue budget includes the operation currently executing"){
    let queue=NativeRequestQueue()
    for n in 0..<64 {try require(queue.enqueue(Data([UInt8(n)]),false).accepted)}
    try require(!queue.enqueue(Data(),false).accepted)
    try require(queue.take().request?.0==Data([0]))
    try require(!queue.enqueue(Data(),false).accepted)
    try require(queue.finish().more)
    let next=queue.enqueue(Data([64]),false);try require(next.accepted && !next.schedule)
}
test("EOF drains queued requests and reports closure after the last result"){
    let queue=NativeRequestQueue()
    _=queue.enqueue(Data([1]),false);_=queue.enqueue(Data([2]),false)
    _=queue.take();try require(!queue.close() && !queue.enqueue(Data(),false).accepted)
    let active=queue.finish();try require(active.more && active.closed)
    try require(queue.take().request?.0==Data([2]))
    let last=queue.finish();try require(!last.more && last.closed)
    let empty=NativeRequestQueue();try require(empty.close())
    let end=empty.take();try require(end.request==nil && end.closed)
}
test("concurrent request producers cannot exceed the queue limit or duplicate entries"){
    let queue=NativeRequestQueue()
    DispatchQueue.concurrentPerform(iterations:128) {index in _=queue.enqueue(Data([UInt8(index)]),false)}
    var received=Set<Data>()
    for _ in 0..<64 {
        guard let request=queue.take().request else{throw fail("MISSING_REQUEST")}
        try require(received.insert(request.0).inserted);_=queue.finish()
    }
    try require(received.count==64 && queue.take().request==nil)
    try require(queue.enqueue(Data(),false).schedule)
}
test("secret labels preserve ordinary fields and protect Japanese and identifier forms"){
    for label in ["Shipping address","Author","spinbutton","Quantity","monkey"] {try require(!secretLabel(label))}
    for label in ["PIN","auth","api_key","access-token","accessToken","newPassword","APIKeyInput","apiKey1","password1","accessToken2","暗証番号","パスワード","認証コード","ＡＰＩキー"] {try require(secretLabel(label))}
}
func semanticHistory(_ healthy:Bool=true)->SemanticInputHistory{var h=SemanticInputHistory();h.setHealthy(healthy);return h}
test("semantic: event classification shares the actual listen-only tap mask and excludes unrelated events"){
    try require(semanticInputTypes.count==9 && Set(semanticInputTypes.map{$0.rawValue}).count==9)
    for type in semanticInputTypes{try require(semanticInputKind(type) != nil)}
    for type in [CGEventType.scrollWheel,.leftMouseUp,.keyUp,.tapDisabledByTimeout,.null]{try require(semanticInputKind(type)==nil)}
    try require(semanticInputKind(.mouseMoved)?.pointer==true && semanticInputKind(.mouseMoved)?.activation==false)
    try require(semanticInputKind(.leftMouseDown)?.pointer==true && semanticInputKind(.leftMouseDown)?.activation==true)
    try require(semanticInputKind(.keyDown)?.pointer==false && semanticInputKind(.keyDown)?.activation==true)
}
func permits(_ h:SemanticInputHistory,_ c:SemanticInputCheckpoint,point:CGPoint=CGPoint(x:4,y:0),beforePID:pid_t=10,afterPID:pid_t=10,beforeFocus:SemanticFocusRead = .known,afterFocus:SemanticFocusRead = .known,focusEqual:Bool=true,now:TimeInterval=10.02)->Bool{
    permitsSemanticChange(beforePID:beforePID,afterPID:afterPID,target:20,own:30,beforeFocus:beforeFocus,afterFocus:afterFocus,focusEqual:focusEqual,beforePoint:.zero,afterPoint:point,history:h,checkpoint:c,now:now)
}
test("semantic: stable observations retain strict fallback when monitor unavailable"){
    let h=semanticHistory(false),c=h.checkpoint(10)
    try require(permits(h,c,point:.zero));try require(!permits(h,c))
    try require(!permits(h,c,point:.zero,afterPID:40));try require(!permits(h,c,point:.zero,focusEqual:false))
}
test("semantic: matching fresh external pointer movement is accepted, without an AX replay"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:false,time:10.01)
    try require(permits(h,c));try require(!permits(h,c,point:CGPoint(x:40,y:0)))
}
test("semantic: stale prior future and negative-source pointer evidence cannot excuse a warp"){
    for mode in 0..<4 {
        var h=semanticHistory()
        if mode==1{h.record(source:0,point:CGPoint(x:4,y:0),activation:false,time:9.99)}
        let c=h.checkpoint(10)
        if mode != 1{h.record(source:mode==3 ? -1:0,point:CGPoint(x:4,y:0),activation:false,time:mode==0 ? 10.001 : mode==2 ? 11:10.01)}
        try require(!permits(h,c,now:mode==0 ? 15.10:10.02))
    }
}
test("semantic: target and helper input never explain cursor or activation changes"){
    for source:pid_t in [20,30] {
        var h=semanticHistory();let c=h.checkpoint(10)
        h.record(source:source,point:CGPoint(x:4,y:0),activation:true,time:10.01)
        try require(!permits(h,c));try require(!permits(h,c,point:.zero,afterPID:40))
    }
}
test("semantic: pointer input cannot authorize an unrelated focus or application change"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:false,time:10.01)
    try require(!permits(h,c,afterPID:40));try require(!permits(h,c,focusEqual:false))
}
test("semantic: external activation permits switching outside the target, independent of pointer proof"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:nil,activation:true,time:10.01)
    try require(permits(h,c,point:.zero,afterPID:40));try require(permits(h,c,point:.zero,focusEqual:false))
    try require(!permits(h,c,afterPID:40))
}
test("semantic: target focus theft is rejected even while a user is switching and moving"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:true,time:10.01)
    try require(!permits(h,c,afterPID:20));try require(!permits(h,c,beforePID:20,afterPID:20,focusEqual:false))
    try require(permits(h,c,beforePID:20,afterPID:40))
}
test("semantic: transient foreign AX reads require activation, permission errors remain fatal"){
    var h=semanticHistory();let c=h.checkpoint(10)
    try require(!permits(h,c,point:.zero,afterFocus:.transient))
    h.record(source:0,point:nil,activation:true,time:10.01)
    try require(permits(h,c,point:.zero,afterFocus:.transient))
    try require(!permits(h,c,point:.zero,beforeFocus:.denied));try require(!permits(h,c,point:.zero,afterFocus:.denied))
    try require(!permits(h,c,point:.zero,beforePID:20,afterPID:20,afterFocus:.transient))
}
test("semantic: loss or restart of input monitoring invalidates evidence for the active operation"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:true,time:10.01)
    h.setHealthy(false);try require(!permits(h,c));h.setHealthy(true)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:true,time:10.015)
    try require(!permits(h,c));try require(!permits(h,c,point:.zero,afterPID:40))
    try require(permits(h,c,point:.zero))
}
test("semantic: rounding tolerance is bounded and keyboard activity cannot explain cursor movement"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:false,time:10.01)
    try require(permits(h,c,point:CGPoint(x:4.5,y:0.5)));try require(!permits(h,c,point:CGPoint(x:4.51,y:0)))
    var keyboard=semanticHistory();let keyCheckpoint=keyboard.checkpoint(10)
    keyboard.record(source:0,point:nil,activation:true,time:10.01)
    try require(!permits(keyboard,keyCheckpoint))
}
test("semantic: bounded event retention evicts old proof and retains the newest event"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:true,time:10.01)
    for _ in 0..<512{h.record(source:0,point:nil,activation:false,time:10.01)}
    try require(!permits(h,c));try require(!permits(h,c,point:.zero,afterPID:40))
    h.record(source:0,point:CGPoint(x:4,y:0),activation:true,time:10.015)
    try require(permits(h,c));try require(permits(h,c,point:.zero,afterPID:40))
}
test("semantic: accepted pointer position stays valid when the user pauses, proof cannot be reused"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:false,time:10.01)
    let evidence=h.pointerEvidence(CGPoint(x:4,y:0),since:c,target:20,own:30,now:10.02)!
    let consumed=c.consumingPointer(evidence)
    try require(!permits(h,consumed))
    // The main-thread guard advances its anchor to the accepted point, so no
    // proof is needed while the observed cursor remains there.
    try require(permitsSemanticChange(beforePID:10,afterPID:10,target:20,own:30,beforeFocus:.known,afterFocus:.known,focusEqual:true,beforePoint:CGPoint(x:4,y:0),afterPoint:CGPoint(x:4,y:0),history:h,checkpoint:consumed,now:10.2))
    h.record(source:0,point:CGPoint(x:8,y:0),activation:false,time:10.21)
    try require(h.pointerEvidence(CGPoint(x:8,y:0),since:consumed,target:20,own:30,now:10.22) != nil)
}
func observation(_ pid:pid_t=10,_ x:Double=0,_ focus:SemanticFocusRead = .known)->SemanticProbe{SemanticProbe(state:Probe(pid:pid,focusedApp:AXUIElementCreateApplication(pid),focusedWindow:nil,focused:nil,point:CGPoint(x:x,y:0)),focusRead:focus)}
test("semantic: production state machine follows continuous input and pauses for 1000 virtual samples"){
    var h=semanticHistory();var state=SemanticGuardState(anchor:observation(),checkpoint:h.checkpoint(10),target:20,own:30)
    var x=0.0
    for i in 1...1000{
        let time=10+Double(i)*0.01
        if i%10<7{x+=1;h.record(source:0,point:CGPoint(x:x,y:0),activation:false,time:time-0.001)}
        try require(state.accept(observation(10,x),history:h,now:time))
    }
    try require(!state.accept(observation(10,x-1),history:h,now:20.001))
}
test("semantic: state machine follows external activation but never allows a return to the target"){
    var h=semanticHistory();var state=SemanticGuardState(anchor:observation(),checkpoint:h.checkpoint(10),target:20,own:30)
    h.record(source:0,point:nil,activation:true,time:10.01)
    try require(state.accept(observation(40),history:h,now:10.02))
    try require(state.accept(observation(40),history:h,now:10.4))
    h.record(source:0,point:nil,activation:true,time:10.41)
    try require(!state.accept(observation(20),history:h,now:10.42))
    try require(state.anchor.state.pid==40)
}
test("semantic: older matching coordinates cannot excuse a warp after a newer pointer event"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:false,time:10.01)
    h.record(source:0,point:CGPoint(x:8,y:0),activation:false,time:10.015)
    try require(!permits(h,c));try require(permits(h,c,point:CGPoint(x:8,y:0)))
    h.record(source:20,point:CGPoint(x:4,y:0),activation:false,time:10.018)
    try require(!permits(h,c));try require(!permits(h,c,point:CGPoint(x:8,y:0)))
}
test("semantic: AX IPC delay does not expire valid motion before the first post-dispatch sample"){
    var h=semanticHistory();let c=h.checkpoint(10)
    h.record(source:0,point:CGPoint(x:4,y:0),activation:false,time:10.01)
    try require(permits(h,c,now:10.2));try require(permits(h,c,now:14.9))
    try require(!permits(h,c,now:15.1))
    h.record(source:0,point:CGPoint(x:8,y:0),activation:false,time:10.05)
    try require(!permits(h,c,now:10.2))
}
test("semantic: cursor/history race retries only reads and returns one coherent generation"){
    var h=semanticHistory(),reads=0,points=0
    let value=coherentSemanticCursor(history:{reads+=1;if reads==2{h.record(source:0,point:CGPoint(x:4,y:0),activation:false,time:10.01)};return h},point:{points+=1;return points==1 ? .zero:CGPoint(x:4,y:0)})
    try require(reads==4 && points==2 && value?.point==CGPoint(x:4,y:0) && value?.history.sequence==1)
}
test("semantic: cursor read convergence is bounded and missing cursor cannot invent a safe value"){
    var h=semanticHistory(),reads=0
    let unstable=coherentSemanticCursor(history:{reads+=1;h.record(source:0,point:.zero,activation:false,time:10);return h},point:{.zero})
    try require(unstable==nil && reads==8)
    try require(coherentSemanticCursor(history:{h},point:{nil})==nil)
}
print("\(checks-failures)/\(checks) passed");exit(failures==0 ? 0:1)
