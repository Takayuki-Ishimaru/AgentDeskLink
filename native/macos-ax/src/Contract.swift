import ApplicationServices
import Foundation
import Darwin
struct Failure:Error {let code:String;var uncertain=false}
func fail(_ code:String,_ uncertain:Bool=false)->Failure {Failure(code:code,uncertain:uncertain)}

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
