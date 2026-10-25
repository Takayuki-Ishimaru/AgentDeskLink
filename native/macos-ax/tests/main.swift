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
print("\(checks-failures)/\(checks) passed");exit(failures==0 ? 0:1)
