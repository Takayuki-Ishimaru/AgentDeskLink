// Included after the UIA backend functions, inside namespace adl. All process
// identities and executable paths are launch-time facts, never request fields.
namespace {
bool SameHumanFocus(const FocusProbe& a,const FocusProbe& b){return a.foreground==b.foreground&&a.focus_identity==b.focus_identity&&a.cursor_x==b.cursor_x&&a.cursor_y==b.cursor_y;}
void ForgetOwned(Impl* im){if(im->owned_process)CloseHandle(im->owned_process);im->owned_process=nullptr;im->owned_pid=0;im->owned_start=0;}
Status OwnedState(Impl* im,ApplicationResult& result){
  result={};if(!im->owned_process)return Status::Ok();
  const DWORD waited=WaitForSingleObject(im->owned_process,0);
  if(waited==WAIT_OBJECT_0){ForgetOwned(im);return Status::Ok();}
  unsigned long long started=0;
  if(waited!=WAIT_TIMEOUT||!ProcessStartHandle(im->owned_process,started)||started!=im->owned_start||ExePathFromHandle(im->owned_process)!=im->want_path)
    return Status::Fail("E_TARGET_NOT_FOUND","owned process identity cannot be verified");
  result.running=result.managed=true;return Status::Ok();
}
Status Application(void* context,const std::string& action,ApplicationResult& result){
  auto* im=static_cast<Impl*>(context);
  if(!im->lifecycle_enabled||!OnLifecycleDesktop())return Status::Fail("E_POLICY_DENIED","private lifecycle desktop required");
  if(action!="status"&&action!="launch"&&action!="quit")return Status::Fail("E_INVALID_ARGUMENT","unknown lifecycle action");
  if(im->input_cancelled->load())return Status::Fail("E_CANCELLED","lifecycle cancelled before dispatch");
  Status current=OwnedState(im,result);if(!current.ok()||action=="status")return current;
  if((action=="launch"&&result.running)||(action=="quit"&&!result.running))return Status::Ok();
  FocusProbe before;Status sampled=im->human_probe->Sample(before);if(!sampled.ok())return sampled;
  bool dispatched=false;
  const auto guarded=[&]()->Status{
    if(im->input_cancelled->load())return Status::Fail("E_CANCELLED","lifecycle cancelled",dispatched);
    FocusProbe after;Status status=im->human_probe->Sample(after);
    if(!status.ok()||!SameHumanFocus(before,after))return Status::Fail("E_FOCUS_CHANGED","human input state changed",dispatched);
    return Status::Ok();
  };
  if(action=="launch"){
    STARTUPINFOW startup{};startup.cb=sizeof(startup);startup.dwFlags=STARTF_USESHOWWINDOW|STARTF_FORCEOFFFEEDBACK;startup.wShowWindow=SW_SHOWNOACTIVATE;
    PROCESS_INFORMATION process{};
    // The worker was born on the private desktop. A NULL lpDesktop inherits
    // that desktop; the application inherits no stdio or other native handles.
    if(!CreateProcessW(im->want_path.c_str(),nullptr,nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&process))
      return Status::Fail("E_BACKEND_UNAVAILABLE","configured application could not start");
    dispatched=true;CloseHandle(process.hThread);im->owned_process=process.hProcess;im->owned_pid=process.dwProcessId;
    if(!ProcessStartHandle(im->owned_process,im->owned_start)||ExePathFromHandle(im->owned_process)!=im->want_path)
      return Status::Fail("E_TARGET_NOT_FOUND","new process identity could not be verified",true);
    const ULONGLONG deadline=GetTickCount64()+1500;
    do{Status safe=guarded();if(!safe.ok())return safe;
      const DWORD idle=WaitForInputIdle(im->owned_process,25);if(idle==0||idle==WAIT_FAILED)break;
    }while(GetTickCount64()<deadline);
    Status state=OwnedState(im,result);if(!state.ok())return Status::Fail(state.code,state.message,true);
    if(!result.running)return Status::Fail("E_TARGET_NOT_FOUND","application exited during startup",true);
    result.changed=true;
  }else{
    Status uia=EnsureUia(im);if(!uia.ok())return uia;
    EnumContext candidates;candidates.want_path=&im->want_path;candidates.only_pid=im->owned_pid;
    if(!EnumWindows(CollectCandidates,reinterpret_cast<LPARAM>(&candidates))||candidates.hwnds.size()>kMaxTargets)
      return Status::Fail("E_RESOURCE_LIMIT","cannot enumerate bounded owned windows");
    std::vector<ComPtr<IUIAutomationWindowPattern>> windows;
    for(HWND hwnd:candidates.hwnds){
      ComPtr<IUIAutomationElement> root;
      if(FAILED(im->uia->ElementFromHandle(hwnd,&root))||!root)return Status::Fail("E_TARGET_NOT_FOUND","owned window unavailable");
      int type=0,pid=0;BOOL enabled=FALSE;
      if(FAILED(root->get_CurrentControlType(&type))||FAILED(root->get_CurrentProcessId(&pid))||static_cast<DWORD>(pid)!=im->owned_pid)
        return Status::Fail("E_TARGET_NOT_FOUND","owned window identity changed");
      // UIA can create an auxiliary pane in the application process. It is not
      // the app's closeable window, and is never selected by a title heuristic.
      if(type!=UIA_WindowControlTypeId)continue;
      ComPtr<IUIAutomationWindowPattern> window;BOOL modal=TRUE;WindowInteractionState interaction=WindowInteractionState_NotResponding;
      if(!PatternOf(root.Get(),UIA_WindowPatternId,window)||FAILED(root->get_CurrentIsEnabled(&enabled))||!enabled||
         FAILED(window->get_CurrentIsModal(&modal))||modal||FAILED(window->get_CurrentWindowInteractionState(&interaction))||
         (interaction!=WindowInteractionState_Running&&interaction!=WindowInteractionState_ReadyForUserInteraction))
        return Status::Fail("E_INTERFERENCE_RISK","owned window cannot close normally without a dialog");
      std::string title;if(!TryTextOf(root.Get(),&IUIAutomationElement::get_CurrentName,title)||title.find('*')!=std::string::npos)
        return Status::Fail("E_INTERFERENCE_RISK","owned window reports a modified or unavailable title");
      windows.push_back(window);
    }
    if(windows.empty())return Status::Fail("E_UNSUPPORTED_ACTION","no owned normal-close window");
    for(auto& window:windows){
      Status safe=guarded();if(!safe.ok())return safe;
      ApplicationResult live;Status identity=OwnedState(im,live);if(!identity.ok())return Status::Fail(identity.code,identity.message,dispatched);
      if(!live.running)break;
      dispatched=true;if(FAILED(window->Close()))return Status::Fail("E_PARTIAL_EXECUTION","normal close was not acknowledged",true);
    }
    // Closing the first main window can exit a multiwindow application. The
    // next OwnedState check then releases the handle; that is confirmed exit,
    // not an invalid handle to wait on or an uncertain close timeout.
    if(!im->owned_process)result={false,false,true};
    else{
      const ULONGLONG deadline=GetTickCount64()+2000;
      for(;;){Status safe=guarded();if(!safe.ok())return safe;
        const DWORD waited=WaitForSingleObject(im->owned_process,10);if(waited==WAIT_OBJECT_0){ForgetOwned(im);result={false,false,true};break;}
        if(waited!=WAIT_TIMEOUT||GetTickCount64()>=deadline)return Status::Fail("E_TIMEOUT","normal close did not exit; ownership retained",dispatched);
      }
    }
  }
  const ULONGLONG settled=GetTickCount64()+100;
  do{Status safe=guarded();if(!safe.ok())return safe;Sleep(10);}while(GetTickCount64()<settled);
  return Status::Ok();
}
} // namespace
