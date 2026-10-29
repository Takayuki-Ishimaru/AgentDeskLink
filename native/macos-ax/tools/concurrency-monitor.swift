// Read-only acceptance observer. Never reads key codes, characters, window titles or field values.
import AppKit
import ApplicationServices
import Foundation

func emit(_ value:[String:Any]){if let data=try? JSONSerialization.data(withJSONObject:value,options:.sortedKeys){FileHandle.standardOutput.write(data+Data([10]))}}
final class Observation:@unchecked Sendable{
    var active=false,stopped=false,target:pid_t=0,helpers=Set<Int64>(),started=Date(),label="",samples=0,errors=0
    var keys=0,moves=0,clicks=0,scrolls=0,aiEvents=0,frontChanges=0,focusChanges=0,cursorChanges=0,targetFront=0,targetFocus=0,tapResets=0
    var previousPID:pid_t?,previousFocus:AXUIElement?,previousPoint:CGPoint?,distance=0.0
    var bins:[Int:[String:Int]]=[:]
    func reset(_ request:[String:Any]){
        active=true;target=pid_t(request["target_pid"] as? Int ?? 0);helpers=Set((request["helper_pids"] as? [Int] ?? []).map(Int64.init));started=Date();label=request["label"] as? String ?? ""
        samples=0;errors=0;keys=0;moves=0;clicks=0;scrolls=0;aiEvents=0;frontChanges=0;focusChanges=0;cursorChanges=0;targetFront=0;targetFocus=0;tapResets=0;distance=0;previousPID=nil;previousFocus=nil;previousPoint=nil;bins=[:]
    }
    func event(_ type:CGEventType,_ event:CGEvent){
        guard active else{return};var kind="other"
        switch type{case .keyDown:keys+=1;kind="key_down";case .mouseMoved,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged:moves+=1;kind="pointer";case .leftMouseDown,.rightMouseDown,.otherMouseDown:clicks+=1;kind="click";case .scrollWheel:scrolls+=1;kind="scroll";default:return}
        let source=event.getIntegerValueField(.eventSourceUnixProcessID);if helpers.contains(source)||source==Int64(target){aiEvents+=1}
        let second=max(0,Int(Date().timeIntervalSince(started)));bins[second,default:[:]][kind,default:0]+=1
    }
    func sample(){
        guard active else{return}
        guard let front=NSWorkspace.shared.frontmostApplication,let point=CGEvent(source:nil)?.location else{errors+=1;return}
        let pid=front.processIdentifier,application=AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application,0.15)
        var raw:CFTypeRef?;let code=AXUIElementCopyAttributeValue(application,kAXFocusedUIElementAttribute as CFString,&raw)
        var focus:AXUIElement?
        if code == .success,let raw,CFGetTypeID(raw)==AXUIElementGetTypeID(){focus=(raw as! AXUIElement)}
        else if code != .noValue && code != .attributeUnsupported{errors+=1}
        samples+=1
        if let previousPID,previousPID != pid{frontChanges+=1}
        if let previousFocus,let focus,!CFEqual(previousFocus,focus){focusChanges+=1}
        if let previousPoint,previousPoint != point{cursorChanges+=1;distance+=hypot(point.x-previousPoint.x,point.y-previousPoint.y)}
        if pid==target{targetFront+=1}
        if let focus{var focusedPID:pid_t=0;if AXUIElementGetPid(focus,&focusedPID) == .success && focusedPID==target{targetFocus+=1}}
        previousPID=pid;previousFocus=focus;previousPoint=point
    }
    func snapshot()->[String:Any]{["label":label,"elapsed_ms":Int(Date().timeIntervalSince(started)*1000),"samples":samples,"probe_errors":errors,"key_down_events":keys,"pointer_events":moves,"click_events":clicks,"scroll_events":scrolls,"ai_sourced_input_events":aiEvents,"foreground_transitions":frontChanges,"focus_transitions":focusChanges,"cursor_changed_samples":cursorChanges,"cursor_distance_points":distance,"target_foreground_samples":targetFront,"target_focus_samples":targetFocus,"tap_resets":tapResets,"activity_by_second":bins.keys.sorted().map{["second":$0,"counts":bins[$0]!] as [String:Any]},"records_input_content":false]}
}
let state=Observation()
let types:[CGEventType]=[.keyDown,.mouseMoved,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged,.leftMouseDown,.rightMouseDown,.otherMouseDown,.scrollWheel]
let mask=types.reduce(CGEventMask(0)){$0|(CGEventMask(1)<<$1.rawValue)}
let tap=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:.listenOnly,eventsOfInterest:mask,callback:{_,type,event,context in
    guard let context else{return Unmanaged.passUnretained(event)}
    let state=Unmanaged<Observation>.fromOpaque(context).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {state.tapResets+=1}else{state.event(type,event)}
    return Unmanaged.passUnretained(event)
},userInfo:Unmanaged.passUnretained(state).toOpaque())
if let tap,let source=CFMachPortCreateRunLoopSource(nil,tap,0){CFRunLoopAddSource(CFRunLoopGetMain(),source,.commonModes);CGEvent.tapEnable(tap:tap,enable:true)}
emit(["event":"ready","accessibility":AXIsProcessTrusted(),"input_events_available":tap != nil,"records_input_content":false])
DispatchQueue(label:"observer.stdin").async{
    while let line=readLine(){
        guard let data=line.data(using:.utf8),let request=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{continue}
        let done=DispatchSemaphore(value:0)
        DispatchQueue.main.async{
            switch request["op"] as? String{case "begin":state.reset(request);case "end":state.sample();state.active=false;case "quit":state.stopped=true;default:state.sample()}
            emit(["reply_to":request["id"] ?? 0,"metrics":state.snapshot()]);done.signal()
        };done.wait()
    };DispatchQueue.main.async{state.stopped=true}
}
while !state.stopped{state.sample();if let tap,!CGEvent.tapIsEnabled(tap:tap){CGEvent.tapEnable(tap:tap,enable:true)};RunLoop.current.run(until:Date().addingTimeInterval(0.02))}
if let tap{CGEvent.tapEnable(tap:tap,enable:false)}
