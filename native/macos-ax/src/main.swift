// Fixed semantic/lifecycle and opt-in image IPC. Background paths never post
// input, activate applications, raise windows or set human focus.
import AppKit
import ApplicationServices
import CryptoKit
import Foundation
import Darwin

func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success ? value : nil
}
func checked(_ e:AXUIElement,_ key:String,_ optional:Bool=false) throws -> CFTypeRef? {
    var value:CFTypeRef?;let status=AXUIElementCopyAttributeValue(e,key as CFString,&value)
    return try decodeAttribute(status,value,optional)
}
func stringValue(_ e:AXUIElement,_ key:String,_ cap:Int,_ optional:Bool=true) throws -> String {
    return try boundedString(try checked(e,key,optional),cap)
}
func numericValue(_ e:AXUIElement,_ key:String,_ optional:Bool=true) throws -> NSNumber? {
    guard let value=try checked(e,key,optional) else{return nil}
    guard let result=value as? NSNumber else{throw fail("E_TARGET_NOT_FOUND")};return result
}
func text(_ e: AXUIElement, _ key: String) -> String { attr(e,key) as? String ?? "" }
func number(_ e: AXUIElement, _ key: String) -> NSNumber? { attr(e,key) as? NSNumber }
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func array(_ e: AXUIElement, _ key: String, _ cap: Int) throws -> [AXUIElement] {
    var count = 0
    let status=AXUIElementGetAttributeValueCount(e,key as CFString,&count)
    guard status == .success else {throw fail("E_TARGET_NOT_FOUND")}
    guard count>=0,count<=cap else {throw fail("E_RESOURCE_LIMIT")}
    if count == 0 { return [] }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(e,key as CFString,0,count,&values) == .success,
          let result = values as? [AXUIElement], result.count == count else { throw fail("E_TARGET_NOT_FOUND") }
    return result
}
func digest(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.fragmentsAllowed]) else { return "" }
    return SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()
}
let blocked = try! NSRegularExpression(pattern:"password|secret|credential|token|api.?key|delete|remove|upload|send|submit|purchase|checkout|pay(?:ment)?|log.?in|sign.?in|transfer",options:.caseInsensitive)
func unsafe(_ s: String) -> Bool { blocked.firstMatch(in:s,range:NSRange(s.startIndex...,in:s)) != nil }
func redact(_ s: String) -> String {
    if unsafe(s) || s.contains("@") || s.range(of:#"(?:sk-|Bearer |EMP[-_]?\d)"#,options:.regularExpression) != nil { return "[redacted]" }
    var result = ""
    for c in s { if result.utf8.count + String(c).utf8.count > 512 { break }; result.append(c) }
    return result
}
func role(_ raw: String) -> String {
    ["AXWindow":"window","AXTextField":"textbox","AXTextArea":"textbox","AXButton":"button","AXCheckBox":"checkbox","AXRadioButton":"radio","AXStaticText":"text","AXGroup":"group","AXScrollArea":"region","AXScrollBar":"scrollbar","AXRow":"option","AXCell":"option","AXPopUpButton":"combobox","AXList":"list","AXTabGroup":"tablist" ][raw] ?? "group"
}
final class WindowTarget {
    let id = "t_" + UUID().uuidString
    let app: NSRunningApplication
    let root: AXUIElement
    let started: String
    let executablePath:String?
    var retired = false
    var lastBounds:CGRect?
    init(_ app:NSRunningApplication,_ root:AXUIElement,_ date:String) { self.app=app;self.root=root;self.started=date;self.executablePath=app.executableURL?.resolvingSymlinksInPath().path }
}
struct Node { let ref:AXUIElement; let id:String; let identifier:String; let rawRole:String; let subrole:String; let publicData:[String:Any]; let privateData:[String:Any] }
final class Session {
    let id = "s_" + UUID().uuidString
    let target: WindowTarget
    var revision = 0
    var fingerprint = ""
    var nodes:[Node] = []
    var poisoned = false
    init(_ t:WindowTarget) { target=t }
}
struct Probe {
    let pid:pid_t
    let focusedApp:AXUIElement?
    let focusedWindow:AXUIElement?
    let focused:AXUIElement?
    let point:CGPoint
    static func equal(_ a:AXUIElement?,_ b:AXUIElement?) -> Bool {
        switch (a,b) { case (nil,nil):return true; case(let a?,let b?):return CFEqual(a,b);default:return false }
    }
    func matches(_ b:Probe)->Bool { pid==b.pid && point==b.point && Self.equal(focusedApp,b.focusedApp) && Self.equal(focusedWindow,b.focusedWindow) && Self.equal(focused,b.focused) }
}
final class Broker {
    let appID:String; let appPath:String; let rules:[String:Rule];let allowAll:Bool
    var targets:[WindowTarget]=[]; var sessions:[String:Session]=[:]; var observers:[pid_t:(start:String,observer:AXObserver)]=[:]
    let system = AXUIElementCreateSystemWide()
    let captureBroker: WindowCaptureBroker
    let lifecycle:NativeApplicationLifecycle
    init(_ appID:String,_ appPath:String,_ controls:String?,_ visualEnabled:Bool=false,_ interactiveConfig:String?=nil,_ lifecycleEnabled:Bool=false,_ allowAll:Bool=false) throws {
        self.allowAll=allowAll;self.appID=appID;self.appPath=URL(fileURLWithPath:appPath).resolvingSymlinksInPath().path
        self.captureBroker=WindowCaptureBroker(appID,self.appPath,visualEnabled,allowAll:allowAll)
        self.lifecycle=NativeApplicationLifecycle(appID,self.appPath,lifecycleEnabled)
        guard appPath.hasPrefix("/"), !appID.isEmpty, appID.utf8.count<=128 else {throw fail("E_INVALID_ARGUMENT")}
        var parsed:[String:Rule]=[:]
        if let controls {
            guard controls.hasPrefix("/") else {throw fail("E_INVALID_ARGUMENT")}
            let data=try Data(contentsOf:URL(fileURLWithPath:controls));guard data.count<=65536,
                let dict=try JSONSerialization.jsonObject(with:data) as? [String:[String:Any]],dict.count<=64 else {throw fail("E_INVALID_ARGUMENT")}
            for (id,p) in dict {
                guard !id.isEmpty,id.utf8.count<=512,Set(p.keys).isSubset(of:["role","subrole","allowed"]),let r=p["role"] as? String,
                      let actions=p["allowed"] as? [String],!actions.isEmpty,Set(actions).isSubset(of:["fill","click","check","select","scroll"]) else {throw fail("E_INVALID_ARGUMENT")}
                parsed[id]=Rule(role:r,subrole:p["subrole"] as? String,allowed:Set(actions))
            }
        }
        rules=parsed
        if let config=try NativeInteractiveConfig.parse(interactiveConfig){guard visualEnabled else{throw fail("E_POLICY_DENIED")};captureBroker.input=NativeInteractiveCoordinator(config,parsed,allowAll)}
        guard AXIsProcessTrusted(), AXUIElementSetMessagingTimeout(system,0.25) == .success else {throw fail("E_BACKEND_UNAVAILABLE")}
    }
    func approved(_ app:NSRunningApplication)->Bool {
        !app.isTerminated && (allowAll ? app.activationPolicy == .regular && app.executableURL != nil : app.bundleIdentifier==appID && app.executableURL?.resolvingSymlinksInPath().path==appPath) && processStart(app.processIdentifier) != nil
    }
    func watch(_ t:WindowTarget) throws {
        let pid=t.app.processIdentifier
        if let old=observers[pid],old.start != t.started {
            CFRunLoopRemoveSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(old.observer),.defaultMode);observers.removeValue(forKey:pid)
            for oldTarget in targets where oldTarget.app.processIdentifier==pid && oldTarget.started != t.started {oldTarget.retired=true}
        }
        if observers[pid] == nil {
            var obs:AXObserver?
            let result=AXObserverCreate(pid,{_,element,notification,context in
                guard notification as String == kAXUIElementDestroyedNotification,let context else{return}
                let broker=Unmanaged<Broker>.fromOpaque(context).takeUnretainedValue()
                for t in broker.targets where CFEqual(t.root,element) {t.retired=true}
            },&obs)
            guard result == .success,let obs else {throw fail("E_BACKEND_UNAVAILABLE")}
            observers[pid]=(t.started,obs);CFRunLoopAddSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(obs),.defaultMode)
        }
        guard let obs=observers[pid]?.observer,AXObserverAddNotification(obs,t.root,kAXUIElementDestroyedNotification as CFString,Unmanaged.passUnretained(self).toOpaque()) == .success else {throw fail("E_BACKEND_UNAVAILABLE")}
    }
    func prune() {
        for t in targets where t.app.isTerminated || processStart(t.app.processIdentifier) != t.started {t.retired=true}
        let retained=Set(sessions.values.map{ObjectIdentifier($0.target)})
        for t in targets where t.retired && !retained.contains(ObjectIdentifier(t)) {
            if let obs=observers[t.app.processIdentifier]?.observer {_ = AXObserverRemoveNotification(obs,t.root,kAXUIElementDestroyedNotification as CFString)}
        }
        targets.removeAll{$0.retired && !retained.contains(ObjectIdentifier($0))}
        for (pid,entry) in observers where processStart(pid) != entry.start || !targets.contains(where:{$0.app.processIdentifier==pid && !$0.retired}) {
            CFRunLoopRemoveSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(entry.observer),.defaultMode);observers.removeValue(forKey:pid)
        }
    }
    func discover() throws -> [[String:Any]] {
        prune()
        let candidates=NSWorkspace.shared.runningApplications.filter{approved($0)}
        guard allowAll || candidates.count<=32 else {throw fail("E_RESOURCE_LIMIT")}
        let apps=Array(candidates.prefix(32))
        var found:[WindowTarget]=[]
        for app in apps {
            let roots:[AXUIElement]
            do{roots=try array(AXUIElementCreateApplication(app.processIdentifier),kAXWindowsAttribute,32)}
            catch{if allowAll{continue};throw error}
            for root in roots {
                if allowAll && found.count>=32{break}
                do {
                guard try stringValue(root,kAXRoleAttribute,100,false)==kAXWindowRole else {throw fail("E_TARGET_NOT_FOUND")}
                if let old=targets.first(where:{!$0.retired && $0.app.processIdentifier==app.processIdentifier && $0.started==processStart(app.processIdentifier) && CFEqual($0.root,root)}) {found.append(old)}
                else {
                    guard targets.count<256,let date=processStart(app.processIdentifier) else {throw fail("E_RESOURCE_LIMIT")}
                    let target=WindowTarget(app,root,date);try watch(target);targets.append(target);found.append(target)
                }
                }catch{if !allowAll{throw error}}
            }
        }
        guard found.count<=32 else {throw fail("E_RESOURCE_LIMIT")}
        for target in targets where !found.contains(where:{$0 === target}) {target.retired=true}
        prune()
        var result:[[String:Any]]=[]
        for target in found{do{result.append(try metadata(target))}catch{if !allowAll{throw error};target.retired=true}}
        return result
    }
    func validate(_ t:WindowTarget) throws {
        guard !t.retired,approved(t.app),processStart(t.app.processIdentifier)==t.started,
              let current=NSRunningApplication(processIdentifier:t.app.processIdentifier),approved(current),current.executableURL?.resolvingSymlinksInPath().path==t.executablePath,processStart(current.processIdentifier)==t.started else {t.retired=true;throw fail("E_TARGET_NOT_FOUND")}
        let roots=try array(AXUIElementCreateApplication(t.app.processIdentifier),kAXWindowsAttribute,32)
        guard roots.contains(where:{CFEqual($0,t.root)}) else {t.retired=true;throw fail("E_TARGET_NOT_FOUND")}
    }
    func bounds(_ root:AXUIElement) throws -> CGRect {
        guard let p=attr(root,kAXPositionAttribute),CFGetTypeID(p)==AXValueGetTypeID(),let sz=attr(root,kAXSizeAttribute),CFGetTypeID(sz)==AXValueGetTypeID() else {throw fail("E_TARGET_NOT_FOUND")}
        var point=CGPoint.zero;var size=CGSize.zero
        guard AXValueGetValue(p as! AXValue,.cgPoint,&point),AXValueGetValue(sz as! AXValue,.cgSize,&size),point.x.isFinite,point.y.isFinite,size.width.isFinite,size.height.isFinite,size.width>=0,size.height>=0 else {throw fail("E_TARGET_NOT_FOUND")}
        return CGRect(origin:point,size:size)
    }
    func metadata(_ t:WindowTarget) throws -> [String:Any] {
        let minimized=try numericValue(t.root,kAXMinimizedAttribute)?.boolValue ?? false
        let r:CGRect
        do {r=try bounds(t.root);t.lastBounds=r}
        catch {guard minimized,let cached=t.lastBounds else {throw error};r=cached}
        let screens=NSScreen.screens;let primaryTop=screens.first?.frame.maxY ?? 0
        let ids=screens.compactMap { s->String? in
            let f=s.frame;let rect=CGRect(x:f.minX,y:primaryTop-f.maxY,width:f.width,height:f.height)
            guard r.intersects(rect),let id=s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else{return nil}
            return "display_\(id)"
        }
        return ["target_id":t.id,"application_id":appID,"label":redact(try stringValue(t.root,kAXTitleAttribute,4096)),"window":["bounds":["x":r.minX,"y":r.minY,"width":r.width,"height":r.height,"coordinate_space":"desktop_points_top_left"],"display_ids":ids,"minimized":minimized]]
    }
    func snapshot(_ s:Session) throws -> [String:Any] {
        guard !s.poisoned else {throw fail("E_TARGET_NOT_FOUND")};try validate(s.target)
        guard try numericValue(s.target.root,kAXMinimizedAttribute,false)?.boolValue==false else {throw fail("E_UNSUPPORTED_ACTION")}
        var queue:[(AXUIElement,Int)]=[(s.target.root,0)];var index=0;var nodes:[Node]=[];var truncated=false
        let deadline=Date().addingTimeInterval(2)
        while index<queue.count {
            if Date()>deadline || nodes.count>=1000 {truncated=true;break}
            let (e,depth)=queue[index];index+=1
            var pid:pid_t=0;guard AXUIElementGetPid(e,&pid) == .success,pid==s.target.app.processIdentifier else {throw fail("E_TARGET_NOT_FOUND")}
            let raw=try stringValue(e,kAXRoleAttribute,100,false);guard !raw.isEmpty else {throw fail("E_TARGET_NOT_FOUND")}
            var subValue:CFTypeRef?
            let subStatus=AXUIElementCopyAttributeValue(e,kAXSubroleAttribute as CFString,&subValue)
            let (sub,subroleKnown)=try observedSubrole(subStatus,subValue,raw)
            let identifier=try stringValue(e,kAXIdentifierAttribute,512)
            let title=try stringValue(e,kAXTitleAttribute,4096);var name=title.isEmpty ? try stringValue(e,kAXDescriptionAttribute,4096) : title
            let value=try checked(e,kAXValueAttribute,true)
            guard value==nil || value is String || value is NSNumber else {throw fail("E_TARGET_NOT_FOUND")}
            let str=value as? String ?? (value as? NSNumber)?.stringValue ?? ""
            guard str.utf8.count<=4096,str.utf16.count<=4096 else {throw fail("E_RESOURCE_LIMIT")}
            if raw==kAXStaticTextRole && name.isEmpty {name=str}
            let sensitive=sub==kAXSecureTextFieldSubrole || unsafe(name) || unsafe(identifier) || unsafe(str) || (str.contains("@"))
            let id=s.nodes.first(where:{CFEqual($0.ref,e)})?.id ?? "e_"+UUID().uuidString
            let normalized=role(raw)
            let nativeEnabled=try numericValue(e,kAXEnabledAttribute)?.boolValue ?? false
            var publicData:[String:Any]=["id":id,"role":normalized,"name":sensitive ? "[redacted]" : redact(name),"enabled":subroleKnown && nativeEnabled]
            if value != nil {publicData["value"]=sensitive ? "[redacted]" : redact(str)}
            if normalized=="checkbox" {publicData["checked"]=try numericValue(e,kAXValueAttribute)?.boolValue ?? false}
            if let selected=try numericValue(e,kAXSelectedAttribute) {publicData["selected"]=selected.boolValue}
            if sensitive {publicData["sensitive"]=true}
            let privateData:[String:Any]=["id":id,"identifier":identifier,"role":raw,"subrole":sub,"subroleKnown":subroleKnown,"name":name,"value":str,"public":publicData]
            // AppKit recreates anonymous disabled layout chrome. It cannot authorize an action.
            // Still traverse its children and count the raw tree toward all limits.
            let inertChrome=inertLayoutGroup(role:raw,subrole:sub,identifier:identifier,name:name,value:str,enabled:publicData["enabled"] as? Bool ?? false,hasSelected:publicData["selected"] != nil)
            if !inertChrome {nodes.append(Node(ref:e,id:id,identifier:identifier,rawRole:raw,subrole:sub,publicData:publicData,privateData:privateData))}
            var count=0;let status=AXUIElementGetAttributeValueCount(e,kAXChildrenAttribute as CFString,&count)
            if status == .attributeUnsupported || status == .noValue {continue}
            guard status == .success,count>=0 else {throw fail("E_TARGET_NOT_FOUND")}
            if count==0 {continue}
            if depth>=48 || queue.count+count>1000 {truncated=true;continue}
            queue.append(contentsOf:try array(e,kAXChildrenAttribute,1000).map{($0,depth+1)})
        }
        let fingerprint=digest(["nodes":nodes.map{$0.privateData},"geometry":try metadata(s.target),"truncated":truncated])
        if fingerprint != s.fingerprint {s.revision+=1;s.fingerprint=fingerprint}
        s.nodes=nodes
        return ["revision":s.revision,"elements":nodes.map{$0.publicData},"truncated":truncated]
    }
    func probe() throws -> Probe {
        guard let front=NSWorkspace.shared.frontmostApplication,let point=CGEvent(source:nil)?.location else {throw fail("E_FOCUS_CHANGED")}
        let focusedApp=AXUIElementCreateApplication(front.processIdentifier)
        let focusValue=try checked(focusedApp,kAXFocusedUIElementAttribute,true)
        let windowValue=try checked(focusedApp,kAXFocusedWindowAttribute,true)
        let focused=axElement(focusValue),window=axElement(windowValue)
        guard (focusValue==nil || focused != nil),(windowValue==nil || window != nil) else{throw fail("E_FOCUS_CHANGED")}
        // A focused application may explicitly report AXNoValue (e.g. Codex's
        // chat surface). Retain that exact absence and compare it after dispatch.
        // Transport/permission failures above remain fatal.
        for item in [focusedApp]+[focused,window].compactMap({$0}) {var pid:pid_t=0;guard AXUIElementGetPid(item,&pid) == .success,pid==front.processIdentifier else {throw fail("E_FOCUS_CHANGED")}}
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier==front.processIdentifier else {throw fail("E_FOCUS_CHANGED")}
        return Probe(pid:front.processIdentifier,focusedApp:focusedApp,focusedWindow:window,focused:focused,point:point)
    }
    func settable(_ e:AXUIElement,_ key:String)->Bool {var yes:DarwinBoolean=false;return AXUIElementIsAttributeSettable(e,key as CFString,&yes) == .success && yes.boolValue}
    func press(_ e:AXUIElement,_ action:String) throws {
        var names:CFArray?;guard AXUIElementCopyActionNames(e,&names) == .success,let names=names as? [String],names.contains(action) else {throw fail("E_UNSUPPORTED_ACTION")}
        guard AXUIElementPerformAction(e,action as CFString) == .success else {throw fail("E_PARTIAL_EXECUTION",true)}
    }
    func act(_ s:Session,_ request:[String:Any]) throws -> [String:Any] {
        let fresh=try snapshot(s)
        guard let expected=request["expected_revision"] as? NSNumber,CFGetTypeID(expected) != CFBooleanGetTypeID(),expected.doubleValue==Double(s.revision) else {throw fail("E_STALE_STATE")}
        guard fresh["truncated"] as? Bool == false else {throw fail("E_RESOURCE_LIMIT")}
        guard let id=request["element_id"] as? String,let node=s.nodes.first(where:{$0.id==id}),let action=request["action"] as? String else {throw fail("E_TARGET_NOT_FOUND")}
        if !allowAll {
            guard let rule=rules[node.identifier],rule.allowed.contains(action),rule.role==node.rawRole || rule.role==role(node.rawRole),rule.subrole==nil || rule.subrole==node.subrole else {throw fail("E_POLICY_DENIED")}
            guard s.nodes.filter({$0.identifier==node.identifier && $0.rawRole==node.rawRole}).count==1,node.publicData["sensitive"] as? Bool != true else {throw fail("E_POLICY_DENIED")}
        }
        guard node.publicData["enabled"] as? Bool == true else{throw fail("E_POLICY_DENIED")}
        guard try numericValue(s.target.root,kAXMinimizedAttribute,false)?.boolValue==false else {throw fail("E_UNSUPPORTED_ACTION")}
        let e=node.ref;let before=try probe();var dispatched=false;var operationError:Error?
        do {
            try validate(s.target)
            // Retained references must still belong to this exact root immediately before dispatch.
            var parent=e;var reached=false
            for _ in 0..<49 {
                if CFEqual(parent,s.target.root) {reached=true;break}
                guard let next=axElement(try checked(parent,kAXParentAttribute,false)) else {throw fail("E_STALE_STATE")};parent=next
            }
            guard reached,try stringValue(e,kAXIdentifierAttribute,512,false)==node.identifier,
                  try stringValue(e,kAXRoleAttribute,100,false)==node.rawRole,
                  try stringValue(e,kAXSubroleAttribute,100)==node.subrole,
                  try numericValue(e,kAXEnabledAttribute,false)?.boolValue==true else {throw fail("E_STALE_STATE")}
            switch action {
            case "fill":
                guard role(node.rawRole)=="textbox",let value=request["value"] as? String,value.utf8.count<=4096,!value.contains("\0"),settable(e,kAXValueAttribute) else {throw fail("E_UNSUPPORTED_ACTION")}
                dispatched=true;guard AXUIElementSetAttributeValue(e,kAXValueAttribute as CFString,value as CFString) == .success,try stringValue(e,kAXValueAttribute,4096,false)==value else {throw fail("E_PARTIAL_EXECUTION",true)}
            case "click":
                guard role(node.rawRole)=="button" else {throw fail("E_UNSUPPORTED_ACTION")};dispatched=true;try press(e,kAXPressAction)
            case "check":
                guard role(node.rawRole)=="checkbox",let value=request["checked"] as? NSNumber,CFGetTypeID(value)==CFBooleanGetTypeID(),let old=try numericValue(e,kAXValueAttribute,false),[0,1].contains(old.intValue) else {throw fail("E_UNSUPPORTED_ACTION")}
                if old.boolValue != value.boolValue {dispatched=true;try press(e,kAXPressAction)}
                guard try numericValue(e,kAXValueAttribute,false)?.boolValue==value.boolValue else {throw fail("E_PARTIAL_EXECUTION",dispatched)}
            case "select":
                guard role(node.rawRole)=="option",settable(e,kAXSelectedAttribute) else {throw fail("E_UNSUPPORTED_ACTION")}
                dispatched=true;guard AXUIElementSetAttributeValue(e,kAXSelectedAttribute as CFString,kCFBooleanTrue) == .success,try numericValue(e,kAXSelectedAttribute,false)?.boolValue==true else {throw fail("E_PARTIAL_EXECUTION",true)}
            case "scroll":
                guard role(node.rawRole)=="scrollbar",let direction=request["direction"] as? String,["up","down"].contains(direction) else {throw fail("E_UNSUPPORTED_ACTION")}
                dispatched=true;try press(e,direction=="up" ? kAXDecrementAction : kAXIncrementAction)
            default:throw fail("E_UNSUPPORTED_ACTION")
            }
        } catch {operationError=error}
        do {
            // AppKit handlers may activate their app after AXPress returns. Pump notifications
            // and compare throughout a bounded settling interval, without replaying the action.
            let settled=Date().addingTimeInterval(dispatched ? 0.10 : 0)
            repeat {
                if dispatched {RunLoop.current.run(until:Date().addingTimeInterval(0.01))}
                let after=try probe();guard before.matches(after) else {throw fail("E_FOCUS_CHANGED",dispatched)}
            } while Date()<settled
        } catch {s.poisoned=true;throw fail("E_FOCUS_CHANGED",dispatched)}
        if let error=operationError {if dispatched {s.poisoned=true};if let error=error as? Failure {throw Failure(code:error.code,uncertain:dispatched || error.uncertain)};throw fail("E_INTERNAL",dispatched)}
        return ["applied":true,"revision":s.revision]
    }
    func request(_ r:[String:Any]) throws -> [String:Any] {
        guard let op=r["op"] as? String else {throw fail("E_INVALID_ARGUMENT")}
        let fields:[String:Set<String>]=["application":["op","request_id","action"],"discover":["op","request_id"],"open":["op","request_id","target_id","mode"],"snapshot":["op","request_id","target_id","session_id"],"close":["op","request_id","target_id","session_id"],"capture":["op","request_id","target_id","session_id"],"gesture":["op","request_id","target_id","session_id","expected_revision","input_token","surface_id","kind","points","swipe_backend"],"prepare_input":["op","request_id","target_id","session_id","input_token","point","action","expected_target"],"commit_input":["op","request_id","target_id","session_id","confirmation_id","value"],"act":["op","request_id","target_id","session_id","expected_revision","action","element_id","value","checked","direction"]]
        guard let allowed=fields[op],Set(r.keys).isSubset(of:allowed) else {throw fail("E_INVALID_ARGUMENT")}
        if op=="application" {
            guard let action=r["action"] as? String,let id=r["request_id"] as? String else{throw fail("E_INVALID_ARGUMENT")}
            try InputCancellation.shared.begin(id);defer{InputCancellation.shared.end()}
            if action=="status" {return try lifecycle.request(action)}
            let before=try probe()
            return try lifecycle.request(action){guard before.matches(try self.probe()) else{throw fail("E_FOCUS_CHANGED")}}
        }
        if op=="discover" {
            let semantic=try discover(); let visual=try captureBroker.discover()
            guard allowAll || semantic.count+visual.count<=32 else {throw fail("E_RESOURCE_LIMIT")}
            var combined:[[String:Any]]=[]
            if allowAll{for i in 0..<max(semantic.count,visual.count){if i<semantic.count{combined.append(semantic[i])};if i<visual.count{combined.append(visual[i])}}}else{combined=semantic+visual}
            return ["protocol_version":2,"targets":Array(combined.prefix(32)),"mutations_enabled":allowAll || !rules.isEmpty,"focus_control":"probe_guarded_semantic","visual_capture":captureBroker.available,"interactive_input":captureBroker.input?.available ?? false,"gesture_backends":captureBroker.input?.backends ?? []]
        }
        if let targetID=r["target_id"] as? String,captureBroker.owns(targetID) {return try captureBroker.request(op,r,targetID)}
        if op=="capture" {throw fail("E_UNSUPPORTED_ACTION")}
        guard let targetID=r["target_id"] as? String,let target=targets.first(where:{$0.id==targetID && (!$0.retired || op=="close")}) else {throw fail("E_TARGET_NOT_FOUND")}
        if op=="open" {
            guard r["mode"] as? String=="background_semantic" else {throw fail("E_INTERFERENCE_RISK")}
            try validate(target);guard sessions.count<32 else {throw fail("E_RESOURCE_LIMIT")}
            let session=Session(target);sessions[session.id]=session;return ["session_id":session.id]
        }
        guard let sid=r["session_id"] as? String,let s=sessions[sid],s.target === target else {throw fail("E_TARGET_NOT_FOUND")}
        if op=="close" {sessions.removeValue(forKey:sid);prune();return ["closed":true]}
        if op=="snapshot" {return try snapshot(s)}
        return try act(s,r)
    }
}

if Array(CommandLine.arguments.dropFirst())==["--release-input"]{
    do{try NativeInteractiveCoordinator.emergencyRelease();print("{\"released_input\":true}");exit(0)}catch{print("{\"released_input\":false}");exit(2)}
}
var args=Array(CommandLine.arguments.dropFirst());var opts:[String:String]=[:]
let visualFlags=args.filter{$0=="--visual-enabled"}.count
let allowAllFlags=args.filter{$0=="--allow-all"}.count
let lifecycleFlags=args.filter{$0=="--lifecycle-enabled"}.count
guard visualFlags<=1,lifecycleFlags<=1,allowAllFlags<=1 else {exit(2)}
args.removeAll{$0=="--visual-enabled" || $0=="--lifecycle-enabled" || $0=="--allow-all"}
while args.count>=2 {let key=args.removeFirst();if !["--app-id","--app-path","--controls-file","--interactive-config"].contains(key) || opts[key] != nil {exit(2)};opts[key]=args.removeFirst()}
guard args.isEmpty,let appID=opts["--app-id"],let appPath=opts["--app-path"] else {exit(2)}
let broker:Broker
do {broker=try Broker(appID,appPath,opts["--controls-file"],visualFlags==1,opts["--interactive-config"],lifecycleFlags==1,allowAllFlags==1)} catch {FileHandle.standardError.write(Data("AgentDeskLink: native setup unavailable.\n".utf8));exit(2)}
var running=true
let reader=DispatchQueue(label:"adl.stdin")
let pending=NativeRequestQueue()
@MainActor final class NativeRequestDrainer {
static func drain(){
    // One scheduled operation at a time: later broker requests cannot reenter
    // capture's nested run-loop wait. Yield between operations for system work.
    let next=pending.take()
    guard let (data,tooLong)=next.request else{
        if next.closed{running=false};return
    }
    var rid="";var captureResponse=false;var response:[String:Any]
    do {
        guard !tooLong,let request=try JSONSerialization.jsonObject(with:data) as? [String:Any],let id=request["request_id"] as? String,!id.isEmpty,id.utf8.count<=128 else {throw fail("E_INVALID_ARGUMENT")}
        rid=id;captureResponse=request["op"] as? String == "capture";let result=try broker.request(request);response=["ok":true,"request_id":id,"result":result]
    } catch {let error=error as? Failure ?? fail("E_INTERNAL");response=["ok":false,"request_id":rid,"error":["code":error.code],"may_have_executed":error.uncertain]}
    var encoded=(try? JSONSerialization.data(withJSONObject:response,options:.sortedKeys)) ?? Data()
    if encoded.count>(captureResponse ? nativeCaptureMaxResponseBytes : 65536) {response=["ok":false,"request_id":rid,"error":["code":"E_RESOURCE_LIMIT"]];encoded=try! JSONSerialization.data(withJSONObject:response)}
    FileHandle.standardOutput.write(encoded+Data([10]))
    let state=pending.finish()
    if state.more{DispatchQueue.main.async {NativeRequestDrainer.drain()}}else if state.closed{running=false}
}
}
reader.async {
    var buffer=[UInt8]();var oversize=false;var byte:UInt8=0
    while Darwin.read(STDIN_FILENO,&byte,1)>0 {
        if byte != 10 {if buffer.count<65536 {buffer.append(byte)} else {oversize=true};continue}
        let data=Data(buffer);let tooLong=oversize;buffer.removeAll(keepingCapacity:true);oversize=false
        if !tooLong,let cancel=try? JSONSerialization.jsonObject(with:data) as? [String:Any],cancel["op"] as? String=="cancel_input"{
            if Set(cancel.keys)==["op","request_id"],let id=cancel["request_id"] as? String,!id.isEmpty,id.utf8.count<=128{InputCancellation.shared.cancel(id)}
            continue
        }
        let state=pending.enqueue(data,tooLong)
        if !state.accepted{break}
        if state.schedule{DispatchQueue.main.async {NativeRequestDrainer.drain()}}
    }
    InputCancellation.shared.close()
    if pending.close(){DispatchQueue.main.async {NativeRequestDrainer.drain()}}
}
while running {RunLoop.current.run(until:Date().addingTimeInterval(0.05))}
