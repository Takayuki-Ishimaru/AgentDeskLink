// The independent JSON vectors are executed against production Swift, on Mac.
import Foundation
import ApplicationServices
func point(_ value:Any)->CGPoint{let pair=value as! [Double];return CGPoint(x:pair[0],y:pair[1])}
func focus(_ value:Any)->SemanticFocusRead{switch value as! String{case "known":return .known;case "transient":return .transient;default:return .denied}}
let path=CommandLine.arguments.dropFirst().first ?? "native/macos-ax/tests/semantic/cases.json"
let cases=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:path))) as! [[String:Any]]
var failures=0
for c in cases{
    var history=SemanticInputHistory();history.setHealthy(c["healthy"] as! Bool)
    func record(_ rows:[[String:Any]]){for event in rows{history.record(source:pid_t(event["source"] as! Int),point:event["point"] is NSNull ? nil:point(event["point"]!),activation:event["activation"] as! Bool,time:event["at"] as! Double)}}
    record(c["prior_events"] as? [[String:Any]] ?? [])
    let checkpoint=history.checkpoint(c["checkpoint"] as! Double)
    if c["epoch_reset"] as? Bool == true{history.setHealthy(false);history.setHealthy(true)}
    record(c["events"] as? [[String:Any]] ?? [])
    let actual=permitsSemanticChange(beforePID:pid_t(c["before_pid"] as! Int),afterPID:pid_t(c["after_pid"] as! Int),target:pid_t(c["target"] as! Int),own:pid_t(c["own"] as! Int),beforeFocus:focus(c["before_focus"]!),afterFocus:focus(c["after_focus"]!),focusEqual:c["focus_equal"] as! Bool,beforePoint:point(c["before_point"]!),afterPoint:point(c["after_point"]!),history:history,checkpoint:checkpoint,now:c["now"] as! Double)
    let expected=c["expected"] as! Bool
    if actual != expected{failures+=1}
    print("\(actual==expected ? "PASS":"FAIL") \(c["name"]!) expected=\(expected) actual=\(actual)")
}
print("\(cases.count-failures)/\(cases.count) passed");exit(failures==0 ? 0:1)
