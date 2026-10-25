import ApplicationServices
import Foundation
import Darwin
struct Failure:Error {let code:String;var uncertain=false}
func fail(_ code:String,_ uncertain:Bool=false)->Failure {Failure(code:code,uncertain:uncertain)}
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
