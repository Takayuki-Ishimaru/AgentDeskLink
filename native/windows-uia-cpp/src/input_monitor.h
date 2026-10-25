#pragma once
#include <windows.h>
#include "input_ownership.h"
#include <bcrypt.h>
#include <sddl.h>
#include <atomic>
#include <chrono>
#include <future>
#include <string>
#include <thread>
namespace adl {
// Observes without suppressing events. Only this helper's unguessable tagged
// SendInput events are exempt. Unattributed injections are interference too.
class InputMonitor {
  std::thread thread_;
  std::atomic<DWORD> tid_{0};
  std::atomic<ULONGLONG> heartbeat_{0},sequence_{0},own_sequence_{0};
  std::atomic<bool> stop_{false};
  ULONG_PTR tag_=0;
  static inline thread_local InputMonitor* current_=nullptr;
  static LRESULT CALLBACK Mouse(int n,WPARAM w,LPARAM l){
    if(n>=0&&current_){const auto* event=reinterpret_cast<MSLLHOOKSTRUCT*>(l);
      if(!(event->flags&LLMHF_INJECTED)||event->dwExtraInfo!=current_->tag_)++current_->sequence_;else ++current_->own_sequence_;}
    return CallNextHookEx(nullptr,n,w,l);
  }
  static LRESULT CALLBACK Keyboard(int n,WPARAM w,LPARAM l){
    if(n>=0&&current_){const auto* event=reinterpret_cast<KBDLLHOOKSTRUCT*>(l);
      if(!(event->flags&LLKHF_INJECTED)||event->dwExtraInfo!=current_->tag_)++current_->sequence_;else ++current_->own_sequence_;}
    return CallNextHookEx(nullptr,n,w,l);
  }
 public:
  bool Start(){
    // Windows may truncate injected ExtraInfo to 32 bits across the RDP input
    // pipeline. Use a cryptographically random 32-bit tag, and require the
    // OS INJECTED flag as well; never exempt an ordinary hardware event.
    ULONG wire_tag=0;
    if(BCryptGenRandom(nullptr,reinterpret_cast<PUCHAR>(&wire_tag),sizeof(wire_tag),BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0||!wire_tag)return false;tag_=wire_tag;
    std::promise<bool> ready;auto result=ready.get_future();
    thread_=std::thread([this,p=std::move(ready)]()mutable{
      current_=this;tid_=GetCurrentThreadId();MSG msg{};PeekMessageW(&msg,nullptr,0,0,PM_NOREMOVE);
      const auto mouse=SetWindowsHookExW(WH_MOUSE_LL,Mouse,GetModuleHandleW(nullptr),0);
      const auto keyboard=SetWindowsHookExW(WH_KEYBOARD_LL,Keyboard,GetModuleHandleW(nullptr),0);
      const auto timer=SetTimer(nullptr,0,25,nullptr);heartbeat_=GetTickCount64();p.set_value(mouse&&keyboard&&timer);
      if(mouse&&keyboard&&timer)while(!stop_&&GetMessageW(&msg,nullptr,0,0)>0){heartbeat_=GetTickCount64();TranslateMessage(&msg);DispatchMessageW(&msg);}
      if(timer)KillTimer(nullptr,timer);if(mouse)UnhookWindowsHookEx(mouse);if(keyboard)UnhookWindowsHookEx(keyboard);current_=nullptr;
    });
    if(result.wait_for(std::chrono::seconds(2))!=std::future_status::ready||!result.get()){Stop();return false;}return true;
  }
  bool Healthy()const{return heartbeat_.load()&&GetTickCount64()-heartbeat_.load()<=250;}
  ULONGLONG Sequence()const{return sequence_.load();}
  ULONG_PTR Tag()const{return tag_;}
  ULONGLONG OwnSequence()const{return own_sequence_.load();}
  bool AwaitOwn(ULONGLONG sequence)const{for(int n=0;n<250;++n){if(own_sequence_.load()>=sequence)return true;if(!Healthy())return false;Sleep(2);}return false;}
  void Stop(){stop_=true;if(thread_.joinable()){PostThreadMessageW(tid_,WM_QUIT,0,0);thread_.join();}}
  ~InputMonitor(){Stop();}
};
class InputLease {
  HANDLE mutex_=nullptr;bool owned_=false;InputOwnership journal_;
 public:
  InputLease()=default;InputLease(const InputLease&)=delete;InputLease& operator=(const InputLease&)=delete;
  bool Acquire(bool abandoned_allowed=false){
    HANDLE token=nullptr;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return false;
    DWORD count=0;GetTokenInformation(token,TokenUser,nullptr,0,&count);std::string raw(count,'\0');
    if(!GetTokenInformation(token,TokenUser,raw.data(),count,&count)){CloseHandle(token);return false;}CloseHandle(token);
    LPWSTR sid=nullptr;if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(raw.data())->User.Sid,&sid))return false;
    const std::wstring sid_text=sid;const std::wstring name=std::wstring(L"Local\\AgentDeskLink.InteractiveInput.v1.")+sid_text;LocalFree(sid);
    mutex_=CreateMutexW(nullptr,FALSE,name.c_str());if(!mutex_)return false;
    const DWORD wait=WaitForSingleObject(mutex_,0);
    if(wait==WAIT_OBJECT_0||(abandoned_allowed&&wait==WAIT_ABANDONED)){owned_=true;return journal_.Open(sid_text)&&(abandoned_allowed||journal_.Empty());}
    if(wait==WAIT_ABANDONED)ReleaseMutex(mutex_); // Do not adopt an abandoned physical-input state.
    CloseHandle(mutex_);mutex_=nullptr;return false;
  }
  InputOwnership& Journal(){return journal_;}
  ~InputLease(){journal_.Close();if(owned_)ReleaseMutex(mutex_);if(mutex_)CloseHandle(mutex_);}
};
inline bool NoHeldInput(){for(int vk=1;vk<256;++vk)if(GetAsyncKeyState(vk)&0x8000)return false;return true;}
inline bool EmergencyReleaseOwned(InputLease& lease){if(lease.Journal().Empty())return true;InputMonitor monitor;if(!monitor.Start())return false;const auto before=monitor.OwnSequence();return lease.Journal().Recover(monitor.Tag(),[&](UINT count){return monitor.AwaitOwn(before+count);});}
}
