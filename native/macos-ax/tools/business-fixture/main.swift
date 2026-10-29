// Test application: dummy business forms only. No input synthesis or foreground activation.
import AppKit
import Foundation

func emit(_ value:[String:Any]){if let data=try? JSONSerialization.data(withJSONObject:value,options:.sortedKeys){FileHandle.standardOutput.write(data+Data([10]))}}
final class BackgroundPanel:NSPanel{
    override var canBecomeKey:Bool{false}
    override var canBecomeMain:Bool{false}
}
final class BusinessForm:NSObject{
    let window:NSWindow
    var fields:[String:NSTextField]=[:],button:NSButton!,status:NSTextField!
    var caseID="",stage=0,generation="",applies=0
    override init(){
        let screen=NSScreen.screens.first?.visibleFrame ?? NSRect(x:0,y:0,width:1200,height:800)
        window=BackgroundPanel(contentRect:NSRect(x:screen.minX+40,y:screen.minY+40,width:680,height:430),styleMask:[.titled,.closable,.nonactivatingPanel],backing:.buffered,defer:false)
        super.init();window.title="AgentDeskLink Business Acceptance";window.isReleasedWhenClosed=false
        configure(["case_id":"ready","stage":0,"generation":"ready","fields":[]])
        window.orderBack(nil)
    }
    func configure(_ req:[String:Any]){
        caseID=req["case_id"] as? String ?? "";stage=req["stage"] as? Int ?? 0;generation=req["generation"] as? String ?? "";applies=0
        fields.removeAll();window.contentView?.subviews.forEach{$0.removeFromSuperview()}
        let title=NSTextField(labelWithString:"\(caseID) — \(req["workflow"] as? String ?? "Ready")")
        title.frame=NSRect(x:20,y:380,width:630,height:24);window.contentView?.addSubview(title)
        let names=Array((req["fields"] as? [String] ?? []).prefix(6))
        for (index,name) in names.enumerated(){
            let y=CGFloat(335-index*48)
            let label=NSTextField(labelWithString:name);label.frame=NSRect(x:20,y:y,width:145,height:24);window.contentView?.addSubview(label)
            let field=NSTextField();field.frame=NSRect(x:170,y:y,width:460,height:26);field.stringValue="";field.setAccessibilityLabel(name);field.setAccessibilityIdentifier("BusinessField_"+name);window.contentView?.addSubview(field);fields[name]=field
        }
        button=NSButton(title:"Run workflow",target:self,action:#selector(run));button.frame=NSRect(x:20,y:60,width:160,height:32);button.setAccessibilityIdentifier("BusinessRun");window.contentView?.addSubview(button)
        status=NSTextField(labelWithString:"Ready");status.frame=NSRect(x:20,y:8,width:635,height:48);status.maximumNumberOfLines=3;status.setAccessibilityIdentifier("BusinessResult");window.contentView?.addSubview(status)
    }
    @objc func run(){
        applies+=1;button.isEnabled=false;status.stringValue="Working"
        emit(["event":"apply","case_id":caseID,"stage":stage,"generation":generation,"inputs":fields.mapValues{$0.stringValue}])
    }
    func result(_ req:[String:Any]){
        guard req["generation"] as? String==generation,let value=req["result"],let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.fragmentsAllowed]),let text=String(data:data,encoding:.utf8) else{return}
        status.stringValue="RESULT "+text;button.isEnabled=true
    }
    func state()->[String:Any]{["case_id":caseID,"stage":stage,"generation":generation,"inputs":fields.mapValues{$0.stringValue},"status":status.stringValue,"applies":applies]}
}
let app=NSApplication.shared;app.setActivationPolicy(.accessory);app.finishLaunching()
let form=BusinessForm()
app.deactivate()
emit(["event":"ready","pid":ProcessInfo.processInfo.processIdentifier,"application_id":Bundle.main.bundleIdentifier ?? "","physical_input":false])
DispatchQueue(label:"business.stdin").async{
    while let line=readLine(){
        guard let data=line.data(using:.utf8),let request=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else{continue}
        let done=DispatchSemaphore(value:0)
        DispatchQueue.main.async{
            switch request["op"] as? String{
            case "configure":form.configure(request)
            case "result":form.result(request)
            case "quit":emit(["reply_to":request["id"] ?? 0,"closed":true]);done.signal();app.terminate(nil);return
            default:break
            }
            emit(["reply_to":request["id"] ?? 0,"state":form.state()]);done.signal()
        };done.wait()
    }
    DispatchQueue.main.async{app.terminate(nil)}
}
app.run()
