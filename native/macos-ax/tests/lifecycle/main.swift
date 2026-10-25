import AppKit
import Foundation
var failures=0,checks=0
func test(_ name:String,_ body:()throws->Void){checks+=1;do{try body();print("PASS \(name)")}catch{failures+=1;print("FAIL \(name): \(error)")}}
func require(_ condition:Bool)throws{if !condition{throw fail("TEST_FAILED")}}
func denied(_ code:String,_ body:()throws->Void)throws{do{try body()}catch let error as Failure{try require(error.code==code);return};throw fail("EXPECTED_FAILURE")}
test("background launch never activates, hides other apps, prompts or accepts substitution"){
    let c=NativeApplicationLifecycle.backgroundConfiguration()
    try require(!c.activates && c.hides && !c.hidesOthers && !c.promptsUserIfNeeded && !c.addsToRecentItems)
    try require(c.createsNewApplicationInstance && !c.allowsRunningApplicationSubstitution && c.arguments.isEmpty && c.environment.isEmpty)
}
test("ownership includes PID and kernel start time, rejecting reused PIDs"){
    let owner=ManagedApplicationIdentity(pid:123,started:"100:23")
    try require(owner.matches(123,"100:23"))
    try require(!owner.matches(124,"100:23") && !owner.matches(123,"100:24") && !owner.matches(123,nil))
}
test("launch cannot adopt a pre-existing or older process"){
    let owner=ManagedApplicationIdentity(pid:123,started:"100:250000")
    try require(owner.created(after:100.2,excluding:[]))
    try require(!owner.created(after:100.2,excluding:[123]))
    try require(!owner.created(after:100.3,excluding:[]))
    try require(!ManagedApplicationIdentity(pid:123,started:"bad").created(after:0,excluding:[]))
}
test("launch completion publishes success only after cross-thread ownership is available"){
    let ownership=ManagedApplicationOwnership(),completion=ApplicationLaunchCompletion()
    try require(completion.result()==nil && ownership.identity==nil)
    let app=NSRunningApplication.current
    DispatchQueue.global().async {
        ownership.identity=ManagedApplicationIdentity(pid:app.processIdentifier,started:"100:250000")
        completion.finish(app,nil)
    }
    let deadline=ProcessInfo.processInfo.systemUptime+2
    while completion.result()==nil && ProcessInfo.processInfo.systemUptime<deadline {Thread.sleep(forTimeInterval:0.001)}
    guard case .success(let launched)?=completion.result() else{throw fail("MISSING_COMPLETION")}
    try require(ownership.identity?.matches(launched.processIdentifier,"100:250000")==true)
    completion.finish(nil,fail("LATE_ERROR"))
    guard case .success?=completion.result() else{throw fail("COMPLETION_CHANGED")}
}
test("launch errors and missing applications complete without a partial success"){
    for error in [nil,fail("LAUNCH_FAILED")] as [Failure?] {
        let completion=ApplicationLaunchCompletion()
        DispatchQueue.concurrentPerform(iterations:100) {_ in completion.finish(nil,error)}
        guard case .failure(let failure)?=completion.result() else{throw fail("EXPECTED_FAILURE")}
        try require((failure as? Failure)?.code == (error?.code ?? "E_BACKEND_UNAVAILABLE"))
    }
}
test("concurrent ownership updates never expose a torn process identity"){
    let ownership=ManagedApplicationOwnership()
    DispatchQueue.concurrentPerform(iterations:1000) {index in
        ownership.identity=ManagedApplicationIdentity(pid:pid_t(index),started:String(index))
        if let identity=ownership.identity,identity.started != String(identity.pid) {fatalError("Torn ownership")}
    }
    try require(ownership.identity != nil)
    ownership.identity=nil;try require(ownership.identity==nil)
}
test("lifecycle absent opt-in denies every operation"){
    let app=NativeApplicationLifecycle("local.adl.never","/bin/sh",false)
    for action in ["status","launch","quit"]{try denied("E_POLICY_DENIED"){_ = try app.request(action)}}
}
test("only fixed launch status quit actions exist"){
    let app=NativeApplicationLifecycle("local.adl.never","/bin/sh",true)
    for action in ["shell","force","activate","open-url"]{try denied("E_INVALID_ARGUMENT"){_ = try app.request(action)}}
}
test("a bare executable cannot be used as an arbitrary command"){
    let app=NativeApplicationLifecycle("local.adl.never","/bin/sh",true)
    try denied("E_POLICY_DENIED"){_ = try app.request("launch")}
    let status=try app.request("status");try require(status["running"] as? Bool==false && status["managed"] as? Bool==false)
    try require(try app.request("quit")["changed"] as? Bool==false)
}
test("pre-cancellation blocks dispatch"){
    try InputCancellation.shared.begin("lifecycle-test-cancel");InputCancellation.shared.cancel("lifecycle-test-cancel")
    defer{InputCancellation.shared.end()}
    try denied("E_CANCELLED"){_ = try NativeApplicationLifecycle("local.adl.never","/bin/sh",true).request("launch")}
}
print("\(checks-failures)/\(checks) lifecycle checks passed");exit(failures==0 ? 0:1)
