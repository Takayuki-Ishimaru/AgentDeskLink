// Explicit foreground physical input. Never used by background_semantic sessions.
import AppKit
import ApplicationServices
import Darwin
import Foundation

func inputNumber(_ value: Any?) -> Double? {
    guard let number=value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),number.doubleValue.isFinite else{return nil}
    return number.doubleValue
}
struct InputPoint { let x:Double;let y:Double;let t:Double;var cg:CGPoint{CGPoint(x:x,y:y)} }
func requireInputIdle(_ buttons:(CGMouseButton)->Bool = {CGEventSource.buttonState(.combinedSessionState,button:$0)},_ keys:(CGKeyCode)->Bool = {CGEventSource.keyState(.combinedSessionState,key:$0)})throws{
    for raw in 0..<32{guard let button=CGMouseButton(rawValue:UInt32(raw)),!buttons(button) else{throw fail("E_INTERFERENCE_RISK")}}
    for raw in 0..<128{guard !keys(CGKeyCode(raw)) else{throw fail("E_INTERFERENCE_RISK")}}
}
struct InputSurface {let id:String;let region:CGRect;let kinds:Set<String>;let backend:String?}
struct NativeInteractiveConfig {
    let enabled:Bool;let surfaces:[InputSurface]
    static func parse(_ text:String?) throws -> NativeInteractiveConfig? {
        guard let text else{return nil};guard text.utf8.count<=8192,let data=text.data(using:.utf8),let obj=try JSONSerialization.jsonObject(with:data) as? [String:Any],Set(obj.keys)==["enabled","surfaces"],let enabled=obj["enabled"] as? NSNumber,CFGetTypeID(enabled)==CFBooleanGetTypeID(),let rows=obj["surfaces"] as? [[String:Any]],rows.count<=16 else{throw fail("E_INVALID_ARGUMENT")}
        var surfaces:[InputSurface]=[];var ids=Set<String>()
        for row in rows {
            guard Set(row.keys).isSubset(of:["id","region","kinds","swipe_backend"]),let id=row["id"] as? String,!id.isEmpty,id.utf16.count<=100,ids.insert(id).inserted,
                  let region=row["region"] as? [String:Any],Set(region.keys)==["x","y","width","height"],let x=inputNumber(region["x"]),let y=inputNumber(region["y"]),let w=inputNumber(region["width"]),let h=inputNumber(region["height"]),x>=0,y>=0,w>0,h>0,x+w<=4096,y+h<=4096,
                  let kinds=row["kinds"] as? [String],!kinds.isEmpty,Set(kinds).count==kinds.count,Set(kinds).isSubset(of:["drag","swipe"]) else{throw fail("E_INVALID_ARGUMENT")}
            let backend=row["swipe_backend"] as? String
            guard row["swipe_backend"]==nil || backend=="scroll" || backend=="touch" else{throw fail("E_INVALID_ARGUMENT")}
            if kinds.contains("swipe") && backend==nil {throw fail("E_INVALID_ARGUMENT")}
            surfaces.append(InputSurface(id:id,region:CGRect(x:x,y:y,width:w,height:h),kinds:Set(kinds),backend:backend))
        }
        return NativeInteractiveConfig(enabled:enabled.boolValue,surfaces:surfaces)
    }
}
func nativeGesturePoints(_ rows:Any?,_ width:Int,_ height:Int,_ region:CGRect) throws -> [InputPoint] {
    guard let rows=rows as? [[String:Any]],(2...64).contains(rows.count) else{throw fail("E_INVALID_ARGUMENT")}
    var result:[InputPoint]=[]
    for row in rows {
        guard Set(row.keys)==["x","y","t_ms"],let x=inputNumber(row["x"]),let y=inputNumber(row["y"]),let t=inputNumber(row["t_ms"]),x>=0,y>=0,x<Double(width),y<Double(height),region.contains(CGPoint(x:x,y:y)),t>=0,t<=5000,result.isEmpty ? t==0 : t>result.last!.t else{throw fail("E_INVALID_ARGUMENT")}
        result.append(InputPoint(x:x,y:y,t:t))
    }
    guard result.dropFirst().contains(where:{$0.x != result[0].x || $0.y != result[0].y}) else{throw fail("E_INVALID_ARGUMENT")}
    return result
}
// All mutable state is protected by lock, including reads from the stdin queue.
final class InputCancellation: @unchecked Sendable {
    static let shared=InputCancellation()
    private let lock=NSLock();private var active:String?;private var cancelled=Set<String>();private var eof=false;private var deadline:TimeInterval=0
    func begin(_ id:String) throws {lock.lock();defer{lock.unlock()};guard !eof,!cancelled.contains(id) else{throw fail("E_CANCELLED")};active=id;deadline=ProcessInfo.processInfo.systemUptime+6}
    func cancel(_ id:String){lock.lock();if cancelled.count<64 || cancelled.contains(id) || active==id {cancelled.insert(id)}else{eof=true};lock.unlock()}
    func close(){lock.lock();eof=true;lock.unlock()}
    func check() throws {lock.lock();defer{lock.unlock()};guard !eof,active.map({!cancelled.contains($0)}) ?? true else{throw fail("E_CANCELLED")};if active != nil && ProcessInfo.processInfo.systemUptime>=deadline{throw fail("E_TIMEOUT")}}
    func end(){lock.lock();if let active{cancelled.remove(active)};active=nil;lock.unlock()}
}
final class NativeInputLease {
    static let left:UInt32=1,key0:UInt32=2,key51:UInt32=4
    private let descriptor:Int32
    private(set) var owned:UInt32
    private static func readJournal(_ fd:Int32,_ size:off_t)throws->UInt32{
        if size==0{return 0}
        guard size==12 else{throw fail("E_INTERFERENCE_RISK")}
        var bytes=[UInt8](repeating:0,count:12)
        guard pread(fd,&bytes,bytes.count,0)==bytes.count,Array(bytes.prefix(8))==Array("ADLINP1\n".utf8) else{throw fail("E_INTERFERENCE_RISK")}
        let mask=UInt32(bytes[8]) | UInt32(bytes[9])<<8 | UInt32(bytes[10])<<16 | UInt32(bytes[11])<<24
        guard mask & ~UInt32(7)==0 else{throw fail("E_INTERFERENCE_RISK")};return mask
    }
    init(_ path:String="/tmp/agentdesklink-input-\(getuid()).lock",recovery:Bool=false) throws {
        let fd=Darwin.open(path,O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,mode_t(0o600))
        guard fd>=0 else{throw fail("E_INTERFERENCE_RISK")}
        var st=stat()
        guard fstat(fd,&st)==0,(st.st_mode&S_IFMT)==S_IFREG,st.st_uid==getuid(),(st.st_mode&0o777)==0o600,st.st_nlink==1,flock(fd,LOCK_EX|LOCK_NB)==0 else{Darwin.close(fd);throw fail("E_INTERFERENCE_RISK")}
        let mask:UInt32
        do{mask=try Self.readJournal(fd,st.st_size);guard recovery || mask==0 else{throw fail("E_INTERFERENCE_RISK")}}catch{Darwin.close(fd);throw error}
        descriptor=fd;owned=mask
    }
    private func persist(_ mask:UInt32)throws{
        guard mask & ~UInt32(7)==0 else{throw fail("E_INTERNAL")}
        var bytes=Array("ADLINP1\n".utf8)+[UInt8(mask&255),UInt8((mask>>8)&255),UInt8((mask>>16)&255),UInt8((mask>>24)&255)]
        guard pwrite(descriptor,&bytes,bytes.count,0)==bytes.count,ftruncate(descriptor,off_t(bytes.count))==0,fsync(descriptor)==0 else{throw fail("E_PARTIAL_EXECUTION",true)}
        owned=mask
    }
    func mark(_ bit:UInt32)throws{try persist(owned|bit)}
    func clear(_ bit:UInt32)throws{try persist(owned & ~bit)}
    func has(_ bit:UInt32)->Bool{owned & bit != 0}
    deinit{_ = flock(descriptor,LOCK_UN);Darwin.close(descriptor)}
}
func armNativeInput(_ lease:NativeInputLease,_ bit:UInt32,_ verify:()throws->Void)throws{
    guard !lease.has(bit) else{throw fail("E_PARTIAL_EXECUTION",true)}
    try lease.mark(bit)
    do{try verify()}catch{try lease.clear(bit);throw error}
}
// Event-tap and request threads share only state protected by lock; tag is immutable.
final class HumanInputMonitor: @unchecked Sendable {
    let tag:Int64
    private let lock=NSLock();private var changed=false;private var valid=false;private var armed=false;private var stopped=false;private var receipts:[UInt64:UInt64]=[:]
    private var port:CFMachPort?;private var loop:CFRunLoop?
    init(_ tag:Int64) throws {
        self.tag=tag
        let ready=DispatchSemaphore(value:0)
        Thread.detachNewThread{[self] in
            var mask:CGEventMask=0
            for type in [CGEventType.leftMouseDown,.leftMouseUp,.rightMouseDown,.rightMouseUp,.mouseMoved,.leftMouseDragged,.rightMouseDragged,.otherMouseDown,.otherMouseUp,.otherMouseDragged,.scrollWheel,.keyDown,.keyUp,.flagsChanged]{mask |= 1 << type.rawValue}
            let callback:CGEventTapCallBack={_,type,event,context in
                guard let context else{return Unmanaged.passUnretained(event)}
                let monitor=Unmanaged<HumanInputMonitor>.fromOpaque(context).takeUnretainedValue()
                monitor.event(type,event);return Unmanaged.passUnretained(event)
            }
            let tap=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:.listenOnly,eventsOfInterest:mask,callback:callback,userInfo:Unmanaged.passUnretained(self).toOpaque())
            lock.lock();port=tap;loop=CFRunLoopGetCurrent();valid=tap != nil && !stopped;let shouldStop=stopped;lock.unlock()
            guard let tap else{ready.signal();return}
            if shouldStop{CFMachPortInvalidate(tap);ready.signal();return}
            CFRunLoopAddSource(CFRunLoopGetCurrent(),CFMachPortCreateRunLoopSource(kCFAllocatorDefault,tap,0),.commonModes)
            CGEvent.tapEnable(tap:tap,enable:true);ready.signal();CFRunLoopRun();CFMachPortInvalidate(tap)
        }
        guard ready.wait(timeout:.now()+1) == .success else{stop();throw fail("E_BACKEND_UNAVAILABLE")}
        lock.lock();let ok=valid;lock.unlock();guard ok else{throw fail("E_BACKEND_UNAVAILABLE")}
    }
    private static func receiptKey(_ type:CGEventType,_ code:UInt32)->UInt64{UInt64(type.rawValue)<<32 | UInt64(code)}
    private func event(_ type:CGEventType,_ event:CGEvent){
        lock.lock();defer{lock.unlock()}
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {valid=false;changed=true}
        if event.getIntegerValueField(.eventSourceUserData)==tag{
            if type == .leftMouseUp{let key=Self.receiptKey(type,0);receipts[key,default:0]&+=1}
            if type == .keyUp{let code=event.getIntegerValueField(.keyboardEventKeycode);if code==0 || code==51{let key=Self.receiptKey(type,UInt32(code));receipts[key,default:0]&+=1}}
        }else if armed{changed=true}
    }
    func receipt(_ type:CGEventType,_ code:UInt32=0)->UInt64{lock.lock();defer{lock.unlock()};return receipts[Self.receiptKey(type,code),default:0]}
    func waitForUp(_ type:CGEventType,_ code:UInt32=0,after:UInt64)throws{
        let until=ProcessInfo.processInfo.systemUptime+0.3
        while true{
            lock.lock();let ok=valid,received=receipts[Self.receiptKey(type,code),default:0]>after;lock.unlock()
            guard ok else{throw fail("E_PARTIAL_EXECUTION",true)};if received{return}
            guard ProcessInfo.processInfo.systemUptime<until else{throw fail("E_PARTIAL_EXECUTION",true)};Thread.sleep(forTimeInterval:0.005)
        }
    }
    func arm(){lock.lock();armed=true;changed=false;lock.unlock()}
    func check() throws {lock.lock();defer{lock.unlock()};guard valid,!changed else{throw fail("E_FOCUS_CHANGED")}}
    func stop(){lock.lock();let runloop=loop;stopped=true;valid=false;lock.unlock();if let runloop{CFRunLoopPerformBlock(runloop,CFRunLoopMode.commonModes.rawValue){CFRunLoopStop(runloop)};CFRunLoopWakeUp(runloop)}}
}
// AppKit may briefly refuse an AX read while processing an acknowledged input event.
// Retry only cannotComplete, without issuing input; every caller still validates identity/focus.
func inputReadStatus(_ read:()->AXError)throws->AXError{
    let until=ProcessInfo.processInfo.systemUptime+0.3
    while true{
        try InputCancellation.shared.check()
        // Reserve the provider's 50 ms messaging budget before starting another call.
        guard ProcessInfo.processInfo.systemUptime+0.05<until else{return .cannotComplete}
        let status=read()
        guard status == .cannotComplete else{return status}
        Thread.sleep(forTimeInterval:0.005)
    }
}
private func ixAttr(_ e:AXUIElement,_ name:String,_ optional:Bool=true)throws->CFTypeRef?{
    try InputCancellation.shared.check();guard AXUIElementSetMessagingTimeout(e,0.05) == .success else{throw fail("E_BACKEND_UNAVAILABLE")}
    var value:CFTypeRef?;let status=try inputReadStatus{value=nil;return AXUIElementCopyAttributeValue(e,name as CFString,&value)}
    return try decodeAttribute(status,value,optional)
}
private func ixString(_ e:AXUIElement,_ name:String,_ cap:Int=512)throws->String{try boundedString(try ixAttr(e,name),cap)}
private func ixElement(_ value:CFTypeRef?)->AXUIElement?{guard let value,CFGetTypeID(value)==AXUIElementGetTypeID() else{return nil};return (value as! AXUIElement)}
private func ixBool(_ e:AXUIElement,_ name:String)throws->Bool{guard let n=try ixAttr(e,name,false) as? NSNumber,CFGetTypeID(n)==CFBooleanGetTypeID() else{throw fail("E_POLICY_DENIED")};return n.boolValue}
private func ixRole(_ raw:String)->String{["AXButton":"button","AXTextField":"textbox","AXTextArea":"textbox"][raw] ?? raw}
private let ixBlocked=try! NSRegularExpression(pattern:"password|secret|credential|token|api.?key|delete|remove|upload|send|submit|purchase|checkout|pay(?:ment)?|log.?in|sign.?in|transfer",options:.caseInsensitive)
private func ixUnsafe(_ s:String)->Bool{ixBlocked.firstMatch(in:s,range:NSRange(s.startIndex...,in:s)) != nil || s.contains("@") || s.range(of:#"(?:sk-|Bearer |EMP[-_]?\d)"#,options:.regularExpression) != nil}
private func ixBounds(_ e:AXUIElement)throws->CGRect{guard let p=try ixAttr(e,kAXPositionAttribute,false),let s=try ixAttr(e,kAXSizeAttribute,false),CFGetTypeID(p)==AXValueGetTypeID(),CFGetTypeID(s)==AXValueGetTypeID() else{throw fail("E_POLICY_DENIED")};var point=CGPoint.zero,size=CGSize.zero;guard AXValueGetValue(p as! AXValue,.cgPoint,&point),AXValueGetValue(s as! AXValue,.cgSize,&size),point.x.isFinite,point.y.isFinite,size.width.isFinite,size.height.isFinite,size.width>0,size.height>0 else{throw fail("E_POLICY_DENIED")};return CGRect(origin:point,size:size)}
private func ixSelection(_ e:AXUIElement)throws->CFRange{
    guard let selected=try ixAttr(e,kAXSelectedTextRangeAttribute,false),CFGetTypeID(selected)==AXValueGetTypeID() else{throw fail("E_POLICY_DENIED")}
    var range=CFRange();guard AXValueGetValue(selected as! AXValue,.cfRange,&range),range.location>=0,range.length>=0 else{throw fail("E_POLICY_DENIED")};return range
}
private func ixValue(_ e:AXUIElement)throws->String{
    guard let value=try ixAttr(e,kAXValueAttribute,false) as? String else{throw fail("E_POLICY_DENIED")};return try boundedString(value as CFTypeRef,4096)
}
private func ixIdentity(_ e:AXUIElement)throws->String{
    let b=try ixBounds(e),raw=try ixString(e,kAXRoleAttribute);var writable:DarwinBoolean=false
    if [kAXTextFieldRole,kAXTextAreaRole].contains(raw){guard try inputReadStatus({writable=false;return AXUIElementIsAttributeSettable(e,kAXValueAttribute as CFString,&writable)}) == .success else{throw fail("E_POLICY_DENIED")}}
    return captureDigest(["identifier":try ixString(e,kAXIdentifierAttribute),"role":raw,"subrole":try ixString(e,kAXSubroleAttribute),"title":try ixString(e,kAXTitleAttribute),"description":try ixString(e,kAXDescriptionAttribute),"enabled":try ixBool(e,kAXEnabledAttribute),"editable":writable.boolValue,"x":b.minX,"y":b.minY,"w":b.width,"h":b.height])
}
private func ixFingerprint(_ e:AXUIElement)throws->String{
    var state:[String:Any] = ["identity":try ixIdentity(e),"value":try ixString(e,kAXValueAttribute,4096)]
    if let selected=try ixAttr(e,kAXSelectedTextRangeAttribute){
        guard CFGetTypeID(selected)==AXValueGetTypeID() else{throw fail("E_POLICY_DENIED")}
        var range=CFRange();guard AXValueGetValue(selected as! AXValue,.cfRange,&range),range.location>=0,range.length>=0 else{throw fail("E_POLICY_DENIED")}
        state["selection"]=["start":range.location,"length":range.length]
    }
    return captureDigest(state)
}
func inputTextStateMatches(_ actual:String,_ range:CFRange,_ expected:String,_ start:Int,_ length:Int)->Bool{
    actual==expected && range.location==start && range.length==length
}
struct InputFrame {let token:String;let window:CaptureWindow;let width:Int;let height:Int;let expires:TimeInterval
    func desktop(_ p:CGPoint)->CGPoint{CGPoint(x:window.frame.minX+p.x*window.frame.width/Double(width),y:window.frame.minY+p.y*window.frame.height/Double(height))}
}
final class PreparedNativeInput {
    let id="confirm_"+UUID().uuidString;let frame:InputFrame;let action:String;let point:CGPoint;let element:AXUIElement;let fingerprint:String;let identity:String;let expires:TimeInterval;let focusedElement:AXUIElement;let focusedWindow:AXUIElement
    init(_ frame:InputFrame,_ action:String,_ point:CGPoint,_ element:AXUIElement,_ fingerprint:String,_ identity:String,_ focusedElement:AXUIElement,_ focusedWindow:AXUIElement){self.frame=frame;self.action=action;self.point=point;self.element=element;self.fingerprint=fingerprint;self.identity=identity;self.focusedElement=focusedElement;self.focusedWindow=focusedWindow;expires=ProcessInfo.processInfo.systemUptime+30}
}
final class NativeInteractiveSession {
    let lease:NativeInputLease;let monitor:HumanInputMonitor;let tag:Int64;var frame:InputFrame?;var proof:PreparedNativeInput?;var pointer:CGPoint;var pressed=false;var poisoned=false;var dispatched=false;var deadline:TimeInterval=0
    init()throws{lease=try NativeInputLease();tag=Int64.random(in:1...Int64.max);monitor=try HumanInputMonitor(tag);pointer=CGEvent(source:nil)?.location ?? .zero}
    deinit{monitor.stop()}
}
final class NativeInteractiveCoordinator {
    let config:NativeInteractiveConfig;let rules:[String:Rule];let allowAll:Bool
    init(_ config:NativeInteractiveConfig,_ rules:[String:Rule],_ allowAll:Bool=false){self.config=config;self.rules=rules;self.allowAll=allowAll}
    var available:Bool{config.enabled && CGPreflightPostEventAccess() && AXIsProcessTrusted()}
    var backends:[String]{guard available else{return []};return (config.surfaces.contains{$0.kinds.contains("drag")} ? ["mouse_drag"]:[])+(config.surfaces.contains{$0.kinds.contains("swipe") && $0.backend=="scroll"} ? ["scroll_swipe"]:[])}
    func open(_ window:CaptureWindow)throws->NativeInteractiveSession{
        guard available,NSWorkspace.shared.frontmostApplication?.processIdentifier==window.pid else{throw fail("E_INTERFERENCE_RISK")}
        try requireInputIdle()
        let point=CGPoint(x:window.frame.midX,y:window.frame.midY)
        guard topWindow(point)==window.windowID else{throw fail("E_INTERFERENCE_RISK")}
        let hit=try hit(point,window.pid),ancestor=try windowAncestor(hit)
        guard let focused=ixElement(try ixAttr(AXUIElementCreateApplication(window.pid),kAXFocusedWindowAttribute,false)),CFEqual(ancestor,focused) else{throw fail("E_INTERFERENCE_RISK")}
        return try NativeInteractiveSession()
    }
    func captured(_ session:NativeInteractiveSession,_ window:CaptureWindow,_ width:Int,_ height:Int)throws->String{
        session.frame=nil
        do{
            // A read-only surrounding-image capture must preserve the prepared proof
            // and its interference history. Only a capture without a proof re-arms it.
            if session.proof==nil{session.monitor.arm()}
            try requireInputIdle();try session.monitor.check()
            guard let pointer=CGEvent(source:nil)?.location else{throw fail("E_BACKEND_UNAVAILABLE")}
            if session.proof != nil{guard abs(pointer.x-session.pointer.x)<=2,abs(pointer.y-session.pointer.y)<=2 else{throw fail("E_FOCUS_CHANGED")}}
            else{session.pointer=pointer}
        }catch{session.proof=nil;throw error}
        let token="input_"+UUID().uuidString;session.frame=InputFrame(token:token,window:window,width:width,height:height,expires:ProcessInfo.processInfo.systemUptime+5);return token
    }
    private func checkedFrame(_ session:NativeInteractiveSession,_ token:Any?)throws->InputFrame{
        guard !session.poisoned,let frame=session.frame,token as? String==frame.token,ProcessInfo.processInfo.systemUptime<frame.expires else{throw fail("E_STALE_STATE")}
        return frame
    }
    private func topWindow(_ point:CGPoint)->CGWindowID?{
        guard let rows=CGWindowListCopyWindowInfo(.optionOnScreenOnly,kCGNullWindowID) as? [[String:Any]] else{return nil}
        for row in rows {
            guard let alpha=row[kCGWindowAlpha as String] as? NSNumber,alpha.doubleValue>0,let bounds=row[kCGWindowBounds as String] as? [String:Any],let rect=CGRect(dictionaryRepresentation:bounds as CFDictionary),rect.contains(point) else{continue}
            // The system cursor is visible WindowServer content at the documented cursor level;
            // it is not an input-occluding window. No application overlay is excluded here.
            if (row[kCGWindowLayer as String] as? NSNumber)?.int32Value==CGWindowLevelForKey(.cursorWindow),let pid=(row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value{
                var path=[CChar](repeating:0,count:4*Int(MAXPATHLEN))
                if proc_pidpath(pid,&path,UInt32(path.count))>0{
                    let executable=String(cString:path)
                    if executable.hasPrefix("/System/Library/") && executable.hasSuffix("/WindowServer"){continue}
                }
            }
            return (row[kCGWindowNumber as String] as? NSNumber).map{CGWindowID($0.uint32Value)}
        }
        return nil
    }
    private func hit(_ point:CGPoint,_ pid:pid_t)throws->AXUIElement{
        let system=AXUIElementCreateSystemWide();guard AXUIElementSetMessagingTimeout(system,0.05) == .success else{throw fail("E_BACKEND_UNAVAILABLE")}
        var hit:AXUIElement?;guard try inputReadStatus({hit=nil;return AXUIElementCopyElementAtPosition(system,Float(point.x),Float(point.y),&hit)}) == .success,let hit else{throw fail("E_POLICY_DENIED")}
        var owner:pid_t=0;guard AXUIElementGetPid(hit,&owner) == .success,owner==pid else{throw fail("E_FOCUS_CHANGED")};return hit
    }
    private func windowAncestor(_ hit:AXUIElement)throws->AXUIElement{
        var element=hit
        for _ in 0..<49{if try ixString(element,kAXRoleAttribute)==kAXWindowRole{return element};guard let parent=ixElement(try ixAttr(element,kAXParentAttribute)) else{throw fail("E_POLICY_DENIED")};element=parent}
        throw fail("E_RESOURCE_LIMIT")
    }
    private func safeAncestors(_ hit:AXUIElement,_ gesture:Bool)throws->AXUIElement{
        var element=hit
        for _ in 0..<49{
            let role=try ixString(element,kAXRoleAttribute)
            if !allowAll && gesture && ["AXButton","AXLink","AXTextField","AXTextArea","AXCheckBox","AXRadioButton","AXPopUpButton","AXComboBox","AXMenuItem","AXMenuButton","AXSlider","AXIncrementor","AXStepper","AXScrollBar","AXDisclosureTriangle"].contains(role){throw fail("E_POLICY_DENIED")}
            if !allowAll {
            for key in [kAXIdentifierAttribute,kAXTitleAttribute,kAXDescriptionAttribute,kAXSubroleAttribute]{guard !ixUnsafe(try ixString(element,key)) else{throw fail("E_POLICY_DENIED")}}
            if let value=try ixAttr(element,kAXValueAttribute){if let text=value as? String {guard text.utf8.count<=4096,!ixUnsafe(text) else{throw fail("E_POLICY_DENIED")}}else if !(value is NSNumber){throw fail("E_POLICY_DENIED")}}
            }
            if role==kAXWindowRole{return element}
            guard let parent=ixElement(try ixAttr(element,kAXParentAttribute)) else{throw fail("E_POLICY_DENIED")};element=parent
        }
        throw fail("E_RESOURCE_LIMIT")
    }
    private func validate(_ session:NativeInteractiveSession,_ frame:InputFrame,_ point:CGPoint,_ checkCursor:Bool=true,gesture:Bool=false)throws->AXUIElement{
        try InputCancellation.shared.check();try session.monitor.check();guard ProcessInfo.processInfo.systemUptime<session.deadline else{throw fail("E_TIMEOUT")}
        guard !session.poisoned,available,NSWorkspace.shared.frontmostApplication?.processIdentifier==frame.window.pid,captureProcessStart(frame.window.pid)==frame.window.started else{throw fail("E_FOCUS_CHANGED")}
        guard let rows=CGWindowListCopyWindowInfo(.optionIncludingWindow,frame.window.windowID) as? [[String:Any]],let row=rows.first(where:{($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value==frame.window.windowID}),
              (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value==frame.window.pid,(row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue==true,
              let rect=row[kCGWindowBounds as String] as? [String:Any],let bounds=CGRect(dictionaryRepresentation:rect as CFDictionary),bounds==frame.window.frame,topWindow(point)==frame.window.windowID else{throw fail("E_STALE_STATE")}
        if checkCursor {guard let cursor=CGEvent(source:nil)?.location,abs(cursor.x-session.pointer.x)<=2,abs(cursor.y-session.pointer.y)<=2 else{throw fail("E_FOCUS_CHANGED")}}
        let element=try hit(point,frame.window.pid),ancestor=try safeAncestors(element,gesture)
        guard let focused=ixElement(try ixAttr(AXUIElementCreateApplication(frame.window.pid),kAXFocusedWindowAttribute,false)),CFEqual(ancestor,focused) else{throw fail("E_FOCUS_CHANGED")}
        return element
    }
    private func arm(_ session:NativeInteractiveSession,_ bit:UInt32,_ verify:()throws->Void)throws{
        try armNativeInput(session.lease,bit){
            try InputCancellation.shared.check();try session.monitor.check();try requireInputIdle();try verify()
        }
    }
    private func mouse(_ session:NativeInteractiveSession,_ type:CGEventType,_ point:CGPoint,_ beforeDown:(()throws->Void)?=nil)throws{
        guard let source=CGEventSource(stateID:.privateState),let event=CGEvent(mouseEventSource:source,mouseType:type,mouseCursorPosition:point,mouseButton:.left) else{throw fail("E_INTERNAL")}
        let receipt=session.monitor.receipt(.leftMouseUp)
        if type == .leftMouseDown{guard let beforeDown else{throw fail("E_INTERNAL")};try arm(session,NativeInputLease.left,beforeDown);session.pressed=true}
        source.localEventsSuppressionInterval=0;event.setIntegerValueField(.eventSourceUserData,value:session.tag);event.post(tap:.cghidEventTap);session.dispatched=true;session.pointer=point
        if type == .leftMouseUp{try session.monitor.waitForUp(.leftMouseUp,after:receipt);try waitReleased{CGEventSource.buttonState(.combinedSessionState,button:.left)};try session.lease.clear(NativeInputLease.left);session.pressed=false}
    }
    private static func keyBit(_ code:CGKeyCode)throws->UInt32{if code==0{return NativeInputLease.key0};if code==51{return NativeInputLease.key51};throw fail("E_INTERNAL")}
    private static func waitReleased(_ down:()->Bool)throws{let until=ProcessInfo.processInfo.systemUptime+0.15;while down(){guard ProcessInfo.processInfo.systemUptime<until else{throw fail("E_PARTIAL_EXECUTION",true)};Thread.sleep(forTimeInterval:0.005)}}
    private func waitReleased(_ down:()->Bool)throws{try Self.waitReleased(down)}
    private func releaseKeys(_ session:NativeInteractiveSession)throws{
        for code:CGKeyCode in [0,51]{let bit=try Self.keyBit(code);if session.lease.has(bit){
            guard let source=CGEventSource(stateID:.privateState),let event=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:false) else{throw fail("E_PARTIAL_EXECUTION",true)}
            let receipt=session.monitor.receipt(.keyUp,UInt32(code))
            source.localEventsSuppressionInterval=0;event.flags=[];event.setIntegerValueField(.eventSourceUserData,value:session.tag);event.post(tap:.cghidEventTap);session.dispatched=true
            try session.monitor.waitForUp(.keyUp,UInt32(code),after:receipt);try Self.waitReleased{CGEventSource.keyState(.combinedSessionState,key:code)};try session.lease.clear(bit)
        }}
    }
    private func release(_ session:NativeInteractiveSession)throws{
        try releaseKeys(session)
        if session.pressed || session.lease.has(NativeInputLease.left){let point=CGEvent(source:nil)?.location ?? session.pointer;try mouse(session,.leftMouseUp,point)}
    }
    static func emergencyRelease()throws{
        let lease=try NativeInputLease(recovery:true);defer{withExtendedLifetime(lease){}}
        guard lease.owned != 0 else{return}
        guard CGPreflightPostEventAccess() else{throw fail("E_BACKEND_UNAVAILABLE")}
        let tag=Int64.random(in:1...Int64.max),monitor=try HumanInputMonitor(tag);defer{monitor.stop()}
        for code:CGKeyCode in [0,51]{let bit=try keyBit(code);if lease.has(bit){
            guard let source=CGEventSource(stateID:.privateState),let event=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:false) else{throw fail("E_BACKEND_UNAVAILABLE")}
            let receipt=monitor.receipt(.keyUp,UInt32(code));source.localEventsSuppressionInterval=0;event.flags=[];event.setIntegerValueField(.eventSourceUserData,value:tag);event.post(tap:.cghidEventTap);try monitor.waitForUp(.keyUp,UInt32(code),after:receipt);try waitReleased{CGEventSource.keyState(.combinedSessionState,key:code)};try lease.clear(bit)
        }}
        if lease.has(NativeInputLease.left){
            guard let p=CGEvent(source:nil)?.location,let source=CGEventSource(stateID:.privateState),let event=CGEvent(mouseEventSource:source,mouseType:.leftMouseUp,mouseCursorPosition:p,mouseButton:.left) else{throw fail("E_BACKEND_UNAVAILABLE")}
            let receipt=monitor.receipt(.leftMouseUp);source.localEventsSuppressionInterval=0;event.setIntegerValueField(.eventSourceUserData,value:tag);event.post(tap:.cghidEventTap);try monitor.waitForUp(.leftMouseUp,after:receipt);try waitReleased{CGEventSource.buttonState(.combinedSessionState,button:.left)};try lease.clear(NativeInputLease.left)
        }
    }
    func close(_ session:NativeInteractiveSession)throws{session.frame=nil;session.proof=nil;try release(session);session.monitor.stop()}
    private func operation(_ session:NativeInteractiveSession,_ id:String,_ body:()throws->[String:Any])throws->[String:Any]{
        try InputCancellation.shared.begin(id);session.dispatched=false;session.deadline=ProcessInfo.processInfo.systemUptime+6;defer{InputCancellation.shared.end()}
        do{try requireInputIdle();let result=try body();try release(session);try requireInputIdle();return result}catch{let original=error as? Failure ?? fail("E_INTERNAL");let sent=session.dispatched;do{try release(session)}catch{session.poisoned=true;throw fail("E_PARTIAL_EXECUTION",true)};session.frame=nil;session.proof=nil;if original.code != "E_INVALID_ARGUMENT" && original.code != "E_POLICY_DENIED" {session.poisoned=true};throw fail(original.code,sent || original.uncertain)}
    }
    func gesture(_ session:NativeInteractiveSession,_ r:[String:Any],_ revision:Int)throws->[String:Any]{
        guard let id=r["request_id"] as? String else{throw fail("E_INVALID_ARGUMENT")}
        return try operation(session,id){
            session.proof=nil
            let frame=try checkedFrame(session,r["input_token"])
            guard inputNumber(r["expected_revision"])==Double(revision),let surfaceID=r["surface_id"] as? String,let surface=config.surfaces.first(where:{$0.id==surfaceID}),let kind=r["kind"] as? String,surface.kinds.contains(kind) else{throw fail("E_POLICY_DENIED")}
            guard kind=="drag" || kind=="swipe" else{throw fail("E_UNSUPPORTED_ACTION")}
            if kind=="swipe" {guard surface.backend=="scroll",r["swipe_backend"] as? String=="scroll" else{throw fail("E_UNSUPPORTED_ACTION")}}else if r["swipe_backend"] != nil {throw fail("E_INVALID_ARGUMENT")}
            let points=try nativeGesturePoints(r["points"],frame.width,frame.height,surface.region);session.frame=nil;session.proof=nil
            let first=frame.desktop(points[0].cg);_ = try validate(session,frame,first,gesture:true);try mouse(session,.mouseMoved,first);Thread.sleep(forTimeInterval:0.025);_ = try validate(session,frame,first,gesture:true)
            if kind=="drag" {try mouse(session,.leftMouseDown,first){_ = try self.validate(session,frame,first,gesture:true)}}
            let started=ProcessInfo.processInfo.systemUptime
            for i in 1..<points.count{
                let from=points[i-1],to=points[i],steps=max(1,Int(ceil((to.t-from.t)/16)))
                for step in 1...steps{
                    let fraction=Double(step)/Double(steps),at=started+(from.t+(to.t-from.t)*fraction)/1000
                    while ProcessInfo.processInfo.systemUptime<at{_ = try validate(session,frame,session.pointer,gesture:true);Thread.sleep(forTimeInterval:min(0.008,max(0,at-ProcessInfo.processInfo.systemUptime)))}
                    let point=frame.desktop(CGPoint(x:from.x+(to.x-from.x)*fraction,y:from.y+(to.y-from.y)*fraction));_ = try validate(session,frame,point,gesture:true)
                    if kind=="drag"{try mouse(session,.leftMouseDragged,point)}else{
                        let delta=CGPoint(x:point.x-session.pointer.x,y:point.y-session.pointer.y);try mouse(session,.mouseMoved,point)
                        guard let source=CGEventSource(stateID:.privateState),let event=CGEvent(scrollWheelEvent2Source:source,units:.pixel,wheelCount:2,wheel1:Int32(delta.y.rounded()),wheel2:Int32(delta.x.rounded()),wheel3:0) else{throw fail("E_INTERNAL")}
                        source.localEventsSuppressionInterval=0;event.setIntegerValueField(.eventSourceUserData,value:session.tag);event.post(tap:.cghidEventTap);session.dispatched=true
                    }
                }
            }
            _ = try validate(session,frame,session.pointer,gesture:true);try release(session)
            return ["released_input":true,"verified":"input_sequence_completed","kind":kind,"points_executed":points.count,"backend":kind=="drag" ? "mouse_drag":"scroll_swipe"]
        }
    }
    private func vetted(_ hit:AXUIElement,_ action:String)throws->AXUIElement{
        var element=hit
        for _ in 0..<16{
            let identifier=try ixString(element,kAXIdentifierAttribute),raw=try ixString(element,kAXRoleAttribute),sub=try ixString(element,kAXSubroleAttribute)
            let rule=rules[identifier]
            let permitted=allowAll || (rule.map{$0.allowed.contains(action) && ($0.role==raw || $0.role==ixRole(raw)) && ($0.subrole==nil || $0.subrole==sub)} ?? false)
            if permitted && ((action=="click" && raw==kAXButtonRole) || (action=="fill" && [kAXTextFieldRole,kAXTextAreaRole].contains(raw))){
                guard try ixBool(element,kAXEnabledAttribute) else{throw fail("E_POLICY_DENIED")}
                if action=="click" {guard raw==kAXButtonRole else{throw fail("E_POLICY_DENIED")}}
                else{var writable:DarwinBoolean=false;let status=try inputReadStatus{writable=false;return AXUIElementIsAttributeSettable(element,kAXValueAttribute as CFString,&writable)};guard [kAXTextFieldRole,kAXTextAreaRole].contains(raw),(allowAll || sub != kAXSecureTextFieldSubrole),status == .success,writable.boolValue else{throw fail("E_POLICY_DENIED")}}
                if !allowAll{try unique(element,identifier,raw)}
                return element
            }
            guard let parent=ixElement(try ixAttr(element,kAXParentAttribute)) else{break};element=parent
        }
        throw fail("E_POLICY_DENIED")
    }
    private func unique(_ element:AXUIElement,_ identifier:String,_ raw:String)throws{
        var root=element
        for _ in 0..<49{if try ixString(root,kAXRoleAttribute)==kAXWindowRole{break};guard let parent=ixElement(try ixAttr(root,kAXParentAttribute)) else{throw fail("E_POLICY_DENIED")};root=parent}
        guard try ixString(root,kAXRoleAttribute)==kAXWindowRole else{throw fail("E_POLICY_DENIED")}
        var queue=[root],index=0,matches=0
        while index<queue.count{
            guard queue.count<=1000 else{throw fail("E_RESOURCE_LIMIT")};let item=queue[index];index+=1
            if try ixString(item,kAXIdentifierAttribute)==identifier && ixString(item,kAXRoleAttribute)==raw{matches+=1;guard matches<=1,CFEqual(item,element) else{throw fail("E_POLICY_DENIED")}}
            var childCount=0;try InputCancellation.shared.check();let status=try inputReadStatus{childCount=0;return AXUIElementGetAttributeValueCount(item,kAXChildrenAttribute as CFString,&childCount)}
            if status == .attributeUnsupported || status == .noValue{continue}
            guard status == .success,childCount>=0,queue.count+childCount<=1000 else{throw fail("E_RESOURCE_LIMIT")}
            if childCount>0{var children:CFArray?;guard try inputReadStatus({children=nil;return AXUIElementCopyAttributeValues(item,kAXChildrenAttribute as CFString,0,childCount,&children)}) == .success,let values=children as? [AXUIElement],values.count==childCount else{throw fail("E_POLICY_DENIED")};queue+=values}
        }
        guard matches==1 else{throw fail("E_POLICY_DENIED")}
    }
    private func focused(_ element:AXUIElement,_ pid:pid_t)throws->Bool{guard let current=ixElement(try ixAttr(AXUIElementCreateApplication(pid),kAXFocusedUIElementAttribute,false)) else{return false};return CFEqual(current,element)}
    func prepare(_ session:NativeInteractiveSession,_ r:[String:Any])throws->[String:Any]{
        guard let id=r["request_id"] as? String else{throw fail("E_INVALID_ARGUMENT")}
        return try operation(session,id){
            session.proof=nil
            let frame=try checkedFrame(session,r["input_token"])
            guard let action=r["action"] as? String,["click","fill"].contains(action),let p=r["point"] as? [String:Any],Set(p.keys)==["x","y"],let x=inputNumber(p["x"]),let y=inputNumber(p["y"]),x>=0,y>=0,x<Double(frame.width),y<Double(frame.height) else{throw fail("E_INVALID_ARGUMENT")}
            let point=frame.desktop(CGPoint(x:x,y:y)),hit=try validate(session,frame,point),element=try vetted(hit,action)
            let title=try ixString(element,kAXTitleAttribute),name=try title.isEmpty ? ixString(element,kAXDescriptionAttribute) : title,raw=try ixString(element,kAXRoleAttribute)
            if let expected=r["expected_target"] as? [String:Any]{guard Set(expected.keys).isSubset(of:["role","name"]),expected["role"]==nil || expected["role"] as? String==ixRole(raw),expected["name"]==nil || expected["name"] as? String==name else{throw fail("E_STALE_STATE")}}else if r["expected_target"] != nil{throw fail("E_INVALID_ARGUMENT")}
            let identity=try ixIdentity(element),before=try ixFingerprint(element);try mouse(session,.mouseMoved,point);Thread.sleep(forTimeInterval:0.08)
            let after=try vetted(validate(session,frame,point),action);guard CFEqual(element,after),try ixFingerprint(element)==before else{throw fail("E_STALE_STATE")}
            let app=AXUIElementCreateApplication(frame.window.pid)
            guard let currentFocus=ixElement(try ixAttr(app,kAXFocusedUIElementAttribute,false)),let currentWindow=ixElement(try ixAttr(app,kAXFocusedWindowAttribute,false)) else{throw fail("E_FOCUS_CHANGED")}
            let proof=PreparedNativeInput(frame,action,point,element,before,identity,currentFocus,currentWindow);session.proof=proof;session.frame=nil
            let isFocused=try focused(element,frame.window.pid)
            var target:[String:Any]=["role":ixRole(raw),"name":name,"enabled":true,"focused":isFocused,"editable":action=="fill"]
            if action=="fill",let selected=try ixAttr(element,kAXSelectedTextRangeAttribute),CFGetTypeID(selected)==AXValueGetTypeID(){var range=CFRange();if AXValueGetValue(selected as! AXValue,.cfRange,&range),range.location>=0,range.length>=0{target["selection"]=["start":range.location,"length":range.length]}}
            return ["confirmation_id":proof.id,"expires_in_ms":max(1,Int((proof.expires-ProcessInfo.processInfo.systemUptime)*1000)),"action":action,"target":target,"pointer_on_target":true,"focus_matches_target":isFocused]
        }
    }
    func commit(_ session:NativeInteractiveSession,_ r:[String:Any])throws->[String:Any]{
        guard let id=r["request_id"] as? String else{throw fail("E_INVALID_ARGUMENT")}
        return try operation(session,id){
            guard let proof=session.proof,r["confirmation_id"] as? String==proof.id else{session.proof=nil;throw fail("E_STALE_STATE")};session.proof=nil
            guard ProcessInfo.processInfo.systemUptime<proof.expires else{throw fail("E_STALE_STATE")}
            let app=AXUIElementCreateApplication(proof.frame.window.pid)
            guard let focus=ixElement(try ixAttr(app,kAXFocusedUIElementAttribute,false)),let focusedWindow=ixElement(try ixAttr(app,kAXFocusedWindowAttribute,false)),CFEqual(focus,proof.focusedElement),CFEqual(focusedWindow,proof.focusedWindow) else{throw fail("E_FOCUS_CHANGED")}
            let element=try vetted(validate(session,proof.frame,proof.point),proof.action)
            guard CFEqual(element,proof.element),try ixFingerprint(element)==proof.fingerprint else{throw fail("E_STALE_STATE")}
            var value:String?
            if proof.action=="fill" {guard let text=r["value"] as? String,text.utf8.count<=4096,!text.unicodeScalars.contains(where:{$0.value<32 || $0.value==127 || (0x80...0x9f).contains($0.value)}) else{throw fail("E_INVALID_ARGUMENT")};value=text}else if r["value"] != nil{throw fail("E_INVALID_ARGUMENT")}
            try mouse(session,.leftMouseDown,proof.point){
                let live=try self.vetted(self.validate(session,proof.frame,proof.point),proof.action)
                guard CFEqual(live,element),try ixFingerprint(element)==proof.fingerprint else{throw fail("E_STALE_STATE")}
            };try mouse(session,.leftMouseUp,proof.point);Thread.sleep(forTimeInterval:0.04)
            _ = try validate(session,proof.frame,proof.point)
            if let value{
                let identity=proof.identity
                func currentTarget()throws{
                    let current=try vetted(validate(session,proof.frame,proof.point),"fill")
                    guard CFEqual(current,element),try ixIdentity(element)==identity else{throw fail("E_STALE_STATE",true)}
                    guard try focused(element,proof.frame.window.pid) else{throw fail("E_FOCUS_CHANGED",true)}
                }
                func requireText(_ expected:String,_ start:Int,_ length:Int,_ wait:Bool=false)throws{
                    let until=ProcessInfo.processInfo.systemUptime+(wait ? 0.3:0)
                    while true{
                        try currentTarget()
                        let actual=try ixValue(element)
                        let selection=try ixSelection(element)
                        if inputTextStateMatches(actual,selection,expected,start,length){return}
                        guard wait,ProcessInfo.processInfo.systemUptime<until else{throw fail("E_PARTIAL_EXECUTION",true)}
                        Thread.sleep(forTimeInterval:0.005)
                    }
                }
                try currentTarget()
                // Select-all uses a tagged key pair; plain Unicode payload never passes through clipboard.
                let previous=try ixValue(element)
                try keyPair(session,0,.maskCommand){try currentTarget()}
                try requireText(previous,0,previous.utf16.count,true)
                if value.isEmpty{try currentTarget();try keyPair(session,51,[]){try requireText(previous,0,previous.utf16.count)};try requireText("",0,0,true)}
                var prefix=""
                for chunk in unicodeChunks(value){
                    if prefix.isEmpty{try requireText(previous,0,previous.utf16.count)}else{try requireText(prefix,prefix.utf16.count,0)}
                    guard let source=CGEventSource(stateID:.privateState),let down=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:true),let up=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:false) else{throw fail("E_INTERNAL",true)}
                    source.localEventsSuppressionInterval=0;down.keyboardSetUnicodeString(stringLength:chunk.count,unicodeString:chunk);up.keyboardSetUnicodeString(stringLength:chunk.count,unicodeString:chunk)
                    try arm(session,NativeInputLease.key0){
                        if prefix.isEmpty{try requireText(previous,0,previous.utf16.count)}else{try requireText(prefix,prefix.utf16.count,0)}
                    }
                    let receipt=session.monitor.receipt(.keyUp,0)
                    for event in [down,up]{event.setIntegerValueField(.eventSourceUserData,value:session.tag);event.post(tap:.cghidEventTap);session.dispatched=true}
                    try session.monitor.waitForUp(.keyUp,0,after:receipt);try Self.waitReleased{CGEventSource.keyState(.combinedSessionState,key:0)};try session.lease.clear(NativeInputLease.key0)
                    prefix+=String(decoding:chunk,as:UTF16.self)
                    try requireText(prefix,prefix.utf16.count,0,true)
                }
                try requireText(value,value.utf16.count,0)
            }
            try release(session);return ["released_input":true,"verified":"input_sequence_completed","action":proof.action]
        }
    }
    private func keyPair(_ session:NativeInteractiveSession,_ code:CGKeyCode,_ flags:CGEventFlags,_ beforeDown:()throws->Void)throws{
        guard let source=CGEventSource(stateID:.privateState),let down=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:true),let up=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:false) else{throw fail("E_INTERNAL",true)}
        source.localEventsSuppressionInterval=0
        let bit=try Self.keyBit(code);try arm(session,bit,beforeDown);down.flags=flags;up.flags=[];let receipt=session.monitor.receipt(.keyUp,UInt32(code))
        for event in [down,up]{event.setIntegerValueField(.eventSourceUserData,value:session.tag);event.post(tap:.cghidEventTap);session.dispatched=true}
        try session.monitor.waitForUp(.keyUp,UInt32(code),after:receipt);try Self.waitReleased{CGEventSource.keyState(.combinedSessionState,key:code)};try session.lease.clear(bit)
    }

}
func unicodeChunks(_ value:String)->[[UniChar]]{var result:[[UniChar]]=[];var chunk:[UniChar]=[];for scalar in value.unicodeScalars{let units=Array(String(scalar).utf16);if chunk.count+units.count>32{result.append(chunk);chunk=[]};chunk+=units};if !chunk.isEmpty{result.append(chunk)};return result}
