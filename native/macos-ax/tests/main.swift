import ApplicationServices
import Foundation
var failures=0
func test(_ name:String,_ body:() throws->Void){do{try body();print("PASS \(name)")}catch{failures+=1;print("FAIL \(name): \(error)")}}
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
print("\(11-failures)/11 passed");exit(failures==0 ? 0:1)
