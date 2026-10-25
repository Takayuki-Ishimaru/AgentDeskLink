import AppKit
import ApplicationServices
import Darwin
import Foundation
alarm(20)
var failures=0,count=0
func test(_ name:String,_ body:()throws->Void){count+=1;do{try body();print("PASS \(name)")}catch{failures+=1;print("FAIL \(name): \(error)")}}
func require(_ b:Bool)throws{if !b{throw fail("TEST_FAILED")}}
func denied(_ body:()throws->Void)throws{do{try body()}catch is Failure{return};throw fail("EXPECTED_FAILURE")}
let good=#"{"enabled":true,"surfaces":[{"id":"canvas","region":{"x":1,"y":2,"width":100,"height":100},"kinds":["drag","swipe"],"swipe_backend":"scroll"}]}"#
test("idle guard checks every standard and extra mouse button and key"){
    var buttons=[UInt32](),keys=[CGKeyCode]()
    try requireInputIdle({buttons.append($0.rawValue);return false},{keys.append($0);return false})
    try require(buttons==Array(UInt32(0)..<32) && keys==Array(CGKeyCode(0)..<128))
}
test("idle guard rejects a held extra mouse button or modifier before capture or dispatch"){
    try denied{try requireInputIdle({$0.rawValue==7},{_ in false})}
    try denied{try requireInputIdle({_ in false},{$0==55})}
}
test("interactive input has no default configuration"){try require(try NativeInteractiveConfig.parse(nil)==nil)}
test("strict trusted interactive JSON accepts bounded regions and scroll capability"){let c=try NativeInteractiveConfig.parse(good)!;try require(c.enabled && c.surfaces.count==1 && c.surfaces[0].backend=="scroll")}
test("interactive JSON rejects unknown fields, booleans-as-numbers, duplicates and oversized policy"){
    for text in [good.replacingOccurrences(of:"\"enabled\":true",with:"\"enabled\":1"),good.replacingOccurrences(of:"\"x\":1",with:"\"x\":true"),good.replacingOccurrences(of:"\"x\":1",with:"\"x\":-1"),good.replacingOccurrences(of:"\"drag\",\"swipe\"",with:"\"drag\",\"drag\""),good.replacingOccurrences(of:"\"scroll\"",with:"\"unsupported\""),good.replacingOccurrences(of:"\"width\":100",with:"\"width\":4096"),good+String(repeating:" ",count:8193)]{try denied{_ = try NativeInteractiveConfig.parse(text)}}
}
test("native CLI surface IDs support at most 100 UTF16 code units"){
    let accepted=good.replacingOccurrences(of:"canvas",with:String(repeating:"界",count:100))
    try require(try NativeInteractiveConfig.parse(accepted)!.surfaces[0].id.utf16.count==100)
    try denied{_ = try NativeInteractiveConfig.parse(good.replacingOccurrences(of:"canvas",with:String(repeating:"界",count:101)))}
}
test("at most 16 trusted surfaces and unique IDs"){var obj=try JSONSerialization.jsonObject(with:Data(good.utf8)) as! [String:Any];let row=(obj["surfaces"] as! [[String:Any]])[0];for n in [2,17]{obj["surfaces"]=Array(repeating:row,count:n);let text=String(data:try JSONSerialization.data(withJSONObject:obj),encoding:.utf8)!;try denied{_ = try NativeInteractiveConfig.parse(text)}}}
let valid:[[String:Any]]=[["x":10,"y":10,"t_ms":0],["x":80,"y":70,"t_ms":200]]
let region=CGRect(x:1,y:2,width:100,height:100)
test("gesture path requires bounded source coordinates, time, region and nonzero motion"){
    try require(try nativeGesturePoints(valid,128,128,region).count==2)
    for path in [[],[valid[0]],[["x":10,"y":10,"t_ms":1],valid[1]],[valid[0],["x":80,"y":70,"t_ms":5001]],[valid[0],["x":128,"y":70,"t_ms":200]],[valid[0],["x":0,"y":70,"t_ms":200]],[valid[0],["x":10,"y":10,"t_ms":200]],[valid[0],["x":80,"y":70,"t_ms":0]],Array(repeating:valid[0],count:65)]{try denied{_ = try nativeGesturePoints(path,128,128,region)}}
}
test("gesture path rejects unknown keys and booleans"){try denied{_ = try nativeGesturePoints([["x":true,"y":10,"t_ms":0],valid[1]],128,128,region)};try denied{_ = try nativeGesturePoints([valid[0],["x":80,"y":70,"t_ms":200,"extra":1]],128,128,region)}}
test("per-axis source pixels transform to exact negative desktop points"){
    let window=CaptureWindow(windowID:3,pid:123,started:"1:1",bundleID:"fixture",title:"",frame:CGRect(x:-100,y:-20,width:200,height:100),onScreen:true,layer:0,native:nil)
    let frame=InputFrame(token:"input_test",window:window,width:400,height:100,expires:0)
    try require(frame.desktop(CGPoint(x:20,y:10))==CGPoint(x:-90,y:-10))
}
test("Unicode chunks preserve complete scalar boundaries and exact text"){
    let value=String(repeating:"界🙂",count:60),chunks=unicodeChunks(value)
    try require(chunks.allSatisfy{$0.count<=32} && String(decoding:chunks.flatMap{$0},as:UTF16.self)==value)
    try require(unicodeChunks("").isEmpty)
}
test("typing prefix verification requires exact text plus UTF16 caret and full selection"){
    let value="界🙂"
    try require(inputTextStateMatches(value,CFRange(location:0,length:3),value,0,3))
    try require(inputTextStateMatches(value,CFRange(location:3,length:0),value,3,0))
    try require(!inputTextStateMatches(value,CFRange(location:2,length:0),value,3,0))
    try require(!inputTextStateMatches(value+"x",CFRange(location:3,length:0),value,3,0))
    try require(!inputTextStateMatches(value,CFRange(location:0,length:0),value,0,3))
}
test("exclusive lease rejects second helper and releases without unlink races"){
    let path="/tmp/adl-lease-test-\(UUID().uuidString)";defer{unlink(path)}
    var first:NativeInputLease?=try NativeInputLease(path)
    try denied{_ = try NativeInputLease(path)};first=nil
    let second=try NativeInputLease(path);withExtendedLifetime(second){}
    withExtendedLifetime(first){}
}
test("lease refuses symlink and unsafe file permissions"){
    let path="/tmp/adl-lease-test-\(UUID().uuidString)",other=path+"-other";defer{unlink(path);unlink(other)}
    try Data().write(to:URL(fileURLWithPath:other));chmod(other,0o644);symlink(other,path)
    try denied{_ = try NativeInputLease(path)};unlink(path)
    try denied{_ = try NativeInputLease(other)}
}
test("owned-input journal survives owner death and blocks ordinary new owners until recovery"){
    let path="/tmp/adl-journal-test-\(UUID().uuidString)";defer{unlink(path)}
    var first:NativeInputLease?=try NativeInputLease(path);try first!.mark(NativeInputLease.left|NativeInputLease.key0|NativeInputLease.key51);first=nil
    try denied{_ = try NativeInputLease(path)}
    var recovery:NativeInputLease?=try NativeInputLease(path,recovery:true);try require(recovery!.owned==7)
    try recovery!.clear(NativeInputLease.left|NativeInputLease.key0|NativeInputLease.key51);recovery=nil
    let clean=try NativeInputLease(path);try require(clean.owned==0)
}
test("post-journal denial clears only a never-dispatched intent before any input"){
    let path="/tmp/adl-arm-test-\(UUID().uuidString)";defer{unlink(path)}
    let lease=try NativeInputLease(path);var verified=false
    try denied{try armNativeInput(lease,NativeInputLease.left){verified=true;throw fail("E_CANCELLED")}}
    try require(verified && lease.owned==0)
    try armNativeInput(lease,NativeInputLease.key0){};try require(lease.owned==NativeInputLease.key0)
    try denied{try armNativeInput(lease,NativeInputLease.key0){throw fail("SHOULD_NOT_RUN")}}
    try require(lease.owned==NativeInputLease.key0);try lease.clear(NativeInputLease.key0)
}
test("recovery refuses malformed or unknown ownership journals instead of broad input release"){
    let path="/tmp/adl-journal-test-\(UUID().uuidString)";defer{unlink(path)}
    for bytes in [Data("invalid".utf8),Data(Array("ADLINP1\n".utf8)+[8,0,0,0])]{try bytes.write(to:URL(fileURLWithPath:path));chmod(path,0o600);try denied{_ = try NativeInputLease(path,recovery:true)}}
}
test("AX reads retry only transient cannotComplete and have a bounded convergence window"){
    var attempts=0;let status=try inputReadStatus{attempts+=1;return attempts<3 ? .cannotComplete:.success}
    try require(status == .success && attempts==3)
    attempts=0;let permanent=try inputReadStatus{attempts+=1;return .attributeUnsupported}
    try require(permanent == .attributeUnsupported && attempts==1)
    let started=ProcessInfo.processInfo.systemUptime;let busy=try inputReadStatus{.cannotComplete}
    let elapsed=ProcessInfo.processInfo.systemUptime-started
    try require(busy == .cannotComplete && elapsed>=0.24 && elapsed<0.5)
}
test("cancel during read-only AX convergence prevents another provider call"){
    let c=InputCancellation.shared;try c.begin("r_busy");var attempts=0
    try denied{_ = try inputReadStatus{attempts+=1;c.cancel("r_busy");return .cannotComplete}}
    try require(attempts==1);c.end()
}
test("pre-abort remains effective before active dispatch and never consumes another request"){
    let c=InputCancellation.shared;c.cancel("r_pre");try denied{try c.begin("r_pre")};try c.begin("r_other");try c.check();c.cancel("r_other");try denied{try c.check()};c.end()
}
test("cancellation history overflow fails closed instead of dropping a pre-abort"){
    let c=InputCancellation();for n in 0..<65{c.cancel("r_\(n)")}
    try denied{try c.begin("r_64")};try denied{try c.begin("r_future")}
}
test("EOF cancels active input even without a cancel message"){let c=InputCancellation.shared;try c.begin("r_eof");c.close();try denied{try c.check()};c.end()}
print("\(count-failures)/\(count) interactive contract tests passed");exit(failures==0 ? 0:1)
