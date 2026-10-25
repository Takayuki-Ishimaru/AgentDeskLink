#pragma once
#include <windows.h>
#include <UIAutomation.h>
#include <wrl/client.h>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <chrono>
#include <cstdint>
#include "protocol.h"
#include "focus_identity.h"
#include "lifecycle_desktop.h"

namespace adl {
// A dedicated read-only client belongs to the human input desktop. The work
// client's focused element on an inactive desktop is not the human's focus.
class HumanFocusProbe {
  std::thread thread_;std::mutex mutex_;std::condition_variable changed_;
  bool stop_=false,ready_=false,healthy_=false;size_t requested_=0,finished_=0;
  HDESK input_=nullptr;
  FocusProbe result_;Status status_=Status::Fail("E_FOCUS_PROBE","human probe unavailable");
  static Status Read(IUIAutomation* uia,const std::wstring& desktop,FocusProbe& out) {
    HDESK input=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);const auto current=DesktopName(input);if(input)CloseDesktop(input);
    if(current.empty()||current!=desktop)return Status::Fail("E_FOCUS_PROBE","human input desktop changed");
    const HWND foreground=GetForegroundWindow();GUITHREADINFO gui{};gui.cbSize=sizeof(gui);POINT point{};
    const DWORD tid=GetWindowThreadProcessId(foreground,nullptr);
    if(!foreground||!tid||!GetGUIThreadInfo(tid,&gui)||!GetCursorPos(&point))return Status::Fail("E_FOCUS_PROBE","human native focus unavailable");
    Microsoft::WRL::ComPtr<IUIAutomationElement> focused;
    if(FAILED(uia->GetFocusedElement(&focused))||!focused)return Status::Fail("E_FOCUS_PROBE","human UIA focus unavailable");
    SAFEARRAY* runtime=nullptr;const HRESULT hr=focused->GetRuntimeId(&runtime);
    const bool valid=SUCCEEDED(hr)&&FocusRuntimeIdentity(runtime,out.focus_identity);if(runtime)SafeArrayDestroy(runtime);
    if(!valid||GetForegroundWindow()!=foreground)return Status::Fail("E_FOCUS_PROBE","human focus identity unavailable");
    out.foreground=reinterpret_cast<unsigned long long>(foreground);out.cursor_x=point.x;out.cursor_y=point.y;
    out.focus_identity+="|g:"+std::to_string(reinterpret_cast<uintptr_t>(gui.hwndFocus));return Status::Ok();
  }
  void Run() {
    HDESK input=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS|DESKTOP_WRITEOBJECTS|DESKTOP_CREATEWINDOW);input_=input;
    const auto desktop=DesktopName(input);const bool attached=input&&!desktop.empty()&&SetThreadDesktop(input);
    const HRESULT initialized=attached?CoInitializeEx(nullptr,COINIT_MULTITHREADED):E_FAIL;
    Microsoft::WRL::ComPtr<IUIAutomation2> uia;
    const bool available=SUCCEEDED(initialized)&&SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation8,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&uia)))&&
      SUCCEEDED(uia->put_AutoSetFocus(FALSE));
    {std::lock_guard<std::mutex> lock(mutex_);healthy_=available;ready_=true;changed_.notify_all();}
    if(available){
      for(;;){size_t ticket;{std::unique_lock<std::mutex> lock(mutex_);changed_.wait(lock,[&]{return stop_||requested_>finished_;});if(stop_)break;ticket=requested_;}
        FocusProbe value;Status status=Read(uia.Get(),desktop,value);
        {std::lock_guard<std::mutex> lock(mutex_);result_=std::move(value);status_=std::move(status);finished_=ticket;changed_.notify_all();}
      }
    }
    uia.Reset();if(SUCCEEDED(initialized))CoUninitialize();
  }
 public:
  bool Start(){thread_=std::thread([this]{Run();});std::unique_lock<std::mutex> lock(mutex_);return changed_.wait_for(lock,std::chrono::seconds(2),[&]{return ready_;})&&healthy_;}
  Status Sample(FocusProbe& out){std::unique_lock<std::mutex> lock(mutex_);if(!healthy_)return status_;const size_t ticket=++requested_;changed_.notify_all();
    if(!changed_.wait_for(lock,std::chrono::seconds(2),[&]{return finished_>=ticket||stop_;})||stop_)return Status::Fail("E_FOCUS_PROBE","human focus probe timed out");out=result_;return status_;}
  ~HumanFocusProbe(){ {std::lock_guard<std::mutex> lock(mutex_);stop_=true;changed_.notify_all();}if(thread_.joinable())thread_.join();if(input_)CloseDesktop(input_);}
};
} // namespace adl
