// Test application only: its JSONL command channel manages its own fixture windows.
import AppKit
import ApplicationServices
import Foundation
final class InputCanvas:NSView {
    var downs=0,drags=0,ups=0,scrolls=0
    override var acceptsFirstResponder:Bool{true}
    override func draw(_ dirtyRect:NSRect){NSColor.systemTeal.setFill();bounds.fill();let text="Synthetic drawing area" as NSString;text.draw(at:NSPoint(x:12,y:bounds.height-30),withAttributes:[.foregroundColor:NSColor.white])}
    override func mouseDown(with event:NSEvent){downs+=1}
    override func mouseDragged(with event:NSEvent){drags+=1;needsDisplay=true}
    override func mouseUp(with event:NSEvent){ups+=1}
    override func scrollWheel(with event:NSEvent){scrolls+=1}
}
final class HoverButton:NSButton {
    var hoverTrap:(()->Void)?
    override func updateTrackingAreas(){super.updateTrackingAreas();for area in trackingAreas{removeTrackingArea(area)};addTrackingArea(NSTrackingArea(rect:bounds,options:[.mouseEnteredAndExited,.activeAlways],owner:self,userInfo:nil))}
    override func mouseEntered(with event:NSEvent){hoverTrap?()}
}
final class FocusField:NSTextField{
    var onFocus:(()->Void)?
    override func becomeFirstResponder()->Bool{let okay=super.becomeFirstResponder();if okay{onFocus?()};return okay}
}
final class Form: NSObject,NSTextFieldDelegate {
    let window:NSWindow;let field=FocusField();let status=NSTextField(labelWithString:"Ready");let check=NSButton(checkboxWithTitle:"Enabled",target:nil,action:nil)
    let index:Int;var typingTrap:String?;var clicks=0;let canvas=InputCanvas();var button:HoverButton!;var overlay:NSButton?;var canvasControl:NSButton?
    init(_ index:Int,_ rect:NSRect) {
        self.index=index;window=NSWindow(contentRect:rect,styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        super.init();window.title="ADL Multiwindow Fixture";window.isReleasedWhenClosed=false
        let view=window.contentView!
        field.delegate=self;field.frame=NSRect(x:20,y:190,width:330,height:26);field.stringValue="Initial-\(index)";field.setAccessibilityLabel("Reference");field.setAccessibilityIdentifier("FixtureText");view.addSubview(field)
        button=HoverButton(title:"Run search",target:self,action:#selector(run));button.frame=NSRect(x:20,y:145,width:150,height:32);button.setAccessibilityIdentifier("FixtureButton");view.addSubview(button)
        check.frame=NSRect(x:190,y:147,width:140,height:26);check.setAccessibilityIdentifier("FixtureCheck");view.addSubview(check)
        status.frame=NSRect(x:20,y:110,width:330,height:24);status.setAccessibilityIdentifier("FixtureStatus");view.addSubview(status)
        let readonly=NSTextField();readonly.frame=NSRect(x:20,y:70,width:330,height:26);readonly.stringValue="Read only";readonly.isEditable=false;readonly.setAccessibilityLabel("Read only");readonly.setAccessibilityIdentifier("FixtureReadOnly");view.addSubview(readonly)
        let secret=NSSecureTextField();secret.frame=NSRect(x:20,y:30,width:330,height:26);secret.stringValue="CANARY_MAC_SECRET";secret.setAccessibilityLabel("Password");secret.setAccessibilityIdentifier("FixturePassword");view.addSubview(secret)
        let interference=NSButton(title:"Interference test",target:self,action:#selector(interfere));interference.frame=NSRect(x:180,y:0,width:170,height:25);interference.setAccessibilityIdentifier("FixtureInterference");view.addSubview(interference)
        canvas.frame=NSRect(x:380,y:20,width:260,height:220);canvas.setAccessibilityElement(true);canvas.setAccessibilityRole(.group);canvas.setAccessibilityLabel("Drawing area");canvas.setAccessibilityIdentifier("FixtureCanvas");view.addSubview(canvas)
        window.orderFront(nil);window.setFrame(rect,display:true)
    }
    func controlTextDidChange(_ notification:Notification){
        guard let trap=typingTrap else{return};typingTrap=nil
        switch trap{
        case "name":field.setAccessibilityLabel("Changed reference")
        case "geometry":field.frame.origin.x+=100
        case "editable":field.isEditable=false
        case "focus":window.makeFirstResponder(canvas)
        case "caret":(window.fieldEditor(false,for:field) as? NSTextView)?.setSelectedRange(NSRange(location:0,length:0))
        case "value":(window.fieldEditor(false,for:field) as? NSTextView)?.string="External replacement"
        default:break
        }
    }
    @objc func interfere(){status.stringValue="Interference invoked";NSApplication.shared.activate(ignoringOtherApps:true);window.makeKeyAndOrderFront(nil);window.makeFirstResponder(field)}
    @objc func run(){clicks+=1;status.stringValue="Done \(field.stringValue) #\(clicks)"}
    func point(_ view:NSView)->[String:Double]{let local=view.convert(NSPoint(x:view.bounds.midX,y:view.bounds.midY),to:nil),screen=window.convertPoint(toScreen:local);return ["x":screen.x,"y":(NSScreen.screens.first?.frame.maxY ?? 0)-screen.y]}
    func trap(){if overlay==nil{let button=NSButton(title:"Delete",target:nil,action:nil);button.frame=self.button.frame;button.setAccessibilityIdentifier("FixtureOverlay");window.contentView?.addSubview(button);overlay=button}}
    func state()->[String:Any]{["held":["left":CGEventSource.buttonState(.combinedSessionState,button:.left),"key0":CGEventSource.keyState(.combinedSessionState,key:0)],"points":["button":point(button),"field":point(field),"readonly":point(window.contentView!.subviews.first(where:{$0.accessibilityIdentifier()=="FixtureReadOnly"})!),"canvas":point(canvas)],"input":["downs":canvas.downs,"drags":canvas.drags,"ups":canvas.ups,"scrolls":canvas.scrolls],"index":index,"field":field.stringValue,"status":status.stringValue,"checked":check.state == .on,"clicks":clicks,"visible":window.isVisible,"minimized":window.isMiniaturized,"frame":["x":window.frame.minX,"y":window.frame.minY,"width":window.frame.width,"height":window.frame.height]]}
}
let app=NSApplication.shared
let human=CommandLine.arguments.contains("--foreground")
let previous=NSWorkspace.shared.frontmostApplication
let mainMenu=NSMenu(),editItem=NSMenuItem(title:"Edit",action:nil,keyEquivalent:""),editMenu=NSMenu(title:"Edit")
editMenu.addItem(NSMenuItem(title:"Select All",action:#selector(NSText.selectAll(_:)),keyEquivalent:"a"));editItem.submenu=editMenu;mainMenu.addItem(editItem);app.mainMenu=mainMenu
final class Restore:NSObject,NSApplicationDelegate {func applicationDidFinishLaunching(_ notification:Notification){if human {app.activate(ignoringOtherApps:true);forms[0]!.window.makeKeyAndOrderFront(nil);forms[0]!.window.makeFirstResponder(forms[0]!.field)}};func applicationWillTerminate(_ notification:Notification){if human {previous?.activate(options:[])}}}
let restore=Restore();app.delegate=restore;app.setActivationPolicy(human ? .regular : .accessory)
var forms:[Int:Form]=[:]
func frame(_ screen:Int)->NSRect {let screens=NSScreen.screens;let s=screens[max(0,min(screen,screens.count-1))].visibleFrame;return NSRect(x:s.minX+50,y:s.maxY-310,width:680,height:260)}
for i in 0..<(human ? 1 : min(3,NSScreen.screens.count)) {forms[i]=Form(i,frame(i))}
if human {forms[0]!.window.title="ADL Human Work Simulation";app.activate();forms[0]!.window.makeKeyAndOrderFront(nil);forms[0]!.window.makeFirstResponder(forms[0]!.field)}
func reply(_ value:[String:Any]){let data=try! JSONSerialization.data(withJSONObject:value,options:.sortedKeys);FileHandle.standardOutput.write(data+Data([10]))}
reply(["ready":true,"windows":forms.keys.sorted().map{forms[$0]!.state()},"screens":NSScreen.screens.enumerated().map{i,s in ["index":i,"x":s.frame.minX,"y":s.frame.minY,"width":s.frame.width,"height":s.frame.height,"scale":s.backingScaleFactor,"display_id":"display_\(s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")]!)"]}])
DispatchQueue(label:"fixture.stdin").async {
    while let line=readLine() {
        guard let data=line.data(using:.utf8),let req=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {continue}
        let done=DispatchSemaphore(value:0)
        DispatchQueue.main.async {
            let i=req["index"] as? Int ?? 0
            switch req["op"] as? String {
            case "background-window":let rect=frame(0).offsetBy(dx:720,dy:0);forms[9]=Form(9,rect)
            case "canvas-button":if let f=forms[i]{let button=NSButton(title:"Inspect",target:f,action:#selector(Form.run));button.frame=NSRect(x:100,y:90,width:60,height:40);button.setAccessibilityIdentifier("FixtureCanvasButton");f.canvas.addSubview(button);f.canvasControl=button}
            case "clear-canvas-button":forms[i]?.canvasControl?.removeFromSuperview();forms[i]?.canvasControl=nil
            case "hold-left","release-left":if let f=forms[i]{let p=f.point(f.canvas);CGEvent(mouseEventSource:nil,mouseType:req["op"] as? String=="hold-left" ? .leftMouseDown:.leftMouseUp,mouseCursorPosition:CGPoint(x:p["x"]!,y:p["y"]!),mouseButton:.left)?.post(tap:.cghidEventTap)}
            case "hold-extra","release-extra":if let f=forms[i],let button=CGMouseButton(rawValue:7){let p=f.point(f.canvas);CGEvent(mouseEventSource:nil,mouseType:req["op"] as? String=="hold-extra" ? .otherMouseDown:.otherMouseUp,mouseCursorPosition:CGPoint(x:p["x"]!,y:p["y"]!),mouseButton:button)?.post(tap:.cghidEventTap)}
            case "hold-key","release-key":if let f=forms[i]{f.window.makeFirstResponder(f.canvas);CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:req["op"] as? String=="hold-key")?.post(tap:.cghidEventTap)}
            case "nudge-pointer":if let point=CGEvent(source:nil)?.location{CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:CGPoint(x:point.x+4,y:point.y),mouseButton:.left)?.post(tap:.cghidEventTap)}
            case "hover-overlay":forms[i]?.button.hoverTrap={forms[i]?.trap()}
            case "overlay":forms[i]?.trap()
            case "clear-overlay":forms[i]?.overlay?.removeFromSuperview();forms[i]?.overlay=nil;forms[i]?.button.hoverTrap=nil
            case "focus-trap":if let f=forms[i]{f.field.onFocus={f.field.onFocus=nil;f.field.setAccessibilityLabel("Changed on focus")}}
            case "typing-trap":forms[i]?.typingTrap=req["kind"] as? String
            case "reset-field":if let f=forms[i]{f.typingTrap=nil;f.field.onFocus=nil;f.window.makeFirstResponder(f.canvas);f.field.isEditable=true;f.field.frame=NSRect(x:20,y:190,width:330,height:26);f.field.setAccessibilityLabel("Reference");f.field.stringValue="Initial-\(i)"}
            case "focus-field":forms[i]?.window.makeFirstResponder(forms[i]?.field)
            case "select-all-range":if let f=forms[i],let editor=f.window.fieldEditor(false,for:f.field) as? NSTextView{editor.setSelectedRange(NSRange(location:0,length:f.field.stringValue.utf16.count))}
            case "select-range":if let f=forms[i],let editor=f.window.fieldEditor(false,for:f.field) as? NSTextView{editor.setSelectedRange(NSRange(location:0,length:0))}
            case "focus-canvas":forms[i]?.window.makeFirstResponder(forms[i]?.canvas)
            case "foreground":NSApplication.shared.activate(ignoringOtherApps:true);forms[i]?.window.makeKeyAndOrderFront(nil);forms[i]?.window.makeFirstResponder(forms[i]?.field)
            case "move":if let f=forms[i] {f.window.setFrame(frame(req["screen"] as? Int ?? 0),display:true)}
            case "span":if let f=forms[i] {f.window.setFrame(NSRect(x:1900,y:400,width:500,height:400),display:true)}
            case "close":forms[i]?.window.close();forms.removeValue(forKey:i)
            case "reopen":forms[i]?.window.close();forms[i]=Form(i,frame(req["screen"] as? Int ?? 0))
            case "minimize":forms[i]?.window.miniaturize(nil)
            case "restore":forms[i]?.window.deminiaturize(nil)
            case "rename":forms[i]?.window.title="ADL Renamed Fixture"
            case "set":forms[i]?.field.stringValue=req["value"] as? String ?? "External"
            case "move-control":if let source=forms[i],let dest=forms[req["to"] as? Int ?? 1] {source.field.removeFromSuperview();dest.window.contentView?.addSubview(source.field)}
            case "large-tree":if let f=forms[i],let v=f.window.contentView {for _ in 0..<1100 {let child=NSView();child.setAccessibilityElement(true);child.setAccessibilityRole(.group);child.setAccessibilityEnabled(false);v.addSubview(child)}}
            case "duplicate":if let f=forms[i],let v=f.window.contentView {let b=NSButton(title:"Run search",target:f,action:#selector(Form.run));b.frame=NSRect(x:20,y:0,width:100,height:25);b.setAccessibilityIdentifier("FixtureButton");v.addSubview(b)}
            case "quit":reply(["closed":true]);app.terminate(nil)
            default:break
            }
            reply(["windows":forms.keys.sorted().map{forms[$0]!.state()}]);done.signal()
        };done.wait()
    }
    DispatchQueue.main.async {app.terminate(nil)}
}
app.run()
