// Test-only external foreground/focus/cursor sampler. It never sends input.
import AppKit
import ApplicationServices
import Foundation
func element(_ e:AXUIElement,_ key:String)->AXUIElement? {var v:CFTypeRef?;guard AXUIElementCopyAttributeValue(e,key as CFString,&v) == .success,let v,CFGetTypeID(v)==AXUIElementGetTypeID() else{return nil};return (v as! AXUIElement)}
func same(_ a:AXUIElement?,_ b:AXUIElement?)->Bool{switch(a,b){case(nil,nil):return true;case(let a?,let b?):return CFEqual(a,b);default:return false}}
func optionalElement(_ e:AXUIElement,_ key:String)->(Bool,AXUIElement?){var v:CFTypeRef?;let s=AXUIElementCopyAttributeValue(e,key as CFString,&v);if s == .noValue || s == .attributeUnsupported{return(true,nil)};guard s == .success,let v,CFGetTypeID(v)==AXUIElementGetTypeID() else{return(false,nil)};return(true,(v as! AXUIElement))}
struct State {let pid:pid_t;let app:AXUIElement;let focus:AXUIElement?;let window:AXUIElement?;let cursor:CGPoint
    func equal(_ b:State)->Bool{pid==b.pid && CFEqual(app,b.app) && same(focus,b.focus) && same(window,b.window) && cursor==b.cursor}}
let system=AXUIElementCreateSystemWide();AXUIElementSetMessagingTimeout(system,0.25)
func sample()->State? {guard AXIsProcessTrusted(),let front=NSWorkspace.shared.frontmostApplication,case let app=AXUIElementCreateApplication(front.processIdentifier),let cursor=CGEvent(source:nil)?.location else{return nil};let(okFocus,focus)=optionalElement(app,kAXFocusedUIElementAttribute), (okWindow,window)=optionalElement(app,kAXFocusedWindowAttribute);guard okFocus,okWindow else{return nil};for item in [app]+[focus,window].compactMap({$0}) {var pid:pid_t=0;guard AXUIElementGetPid(item,&pid) == .success,pid==front.processIdentifier else{return nil}};guard NSWorkspace.shared.frontmostApplication?.processIdentifier==front.processIdentifier else{return nil};return State(pid:front.processIdentifier,app:app,focus:focus,window:window,cursor:cursor)}
var stopped=false
DispatchQueue(label:"monitor.stdin").async {while readLine() != nil {};DispatchQueue.main.async {stopped=true}}
let baseline=sample();var samples=0,changes=0,errors=0,foregroundChanges=0,focusChanges=0,cursorChanges=0
FileHandle.standardOutput.write(Data("{\"ready\":\(baseline != nil)}\n".utf8))
while !stopped {if let baseline,let current=sample() {samples+=1;if !baseline.equal(current){changes+=1};if baseline.pid != current.pid {foregroundChanges+=1};if !same(baseline.focus,current.focus) || !same(baseline.window,current.window){focusChanges+=1};if baseline.cursor != current.cursor{cursorChanges+=1}} else {errors+=1};RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
let result:[String:Any]=["samples":samples,"changed_samples":changes,"foreground_changed_samples":foregroundChanges,"focus_changed_samples":focusChanges,"cursor_changed_samples":cursorChanges,"probe_errors":errors,"requested_interval_ms":10,"platform":"macOS","scope":"foreground PID, exact AX focused app/window/element, cursor; no input synthesis"]
FileHandle.standardOutput.write((try! JSONSerialization.data(withJSONObject:result,options:.sortedKeys))+Data([10]))
