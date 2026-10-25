#pragma once
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

namespace adl {
// Observation only. The registering thread pumps callbacks; no COM or UI actions.
class WindowLifetimeMonitor {
  using Flag = std::atomic<bool>;
  std::mutex mutex_;
  std::map<HWND,std::vector<std::weak_ptr<Flag>>> watched_;
  std::thread thread_;
  std::atomic<DWORD> thread_id_{0};
  std::atomic<bool> stopping_{false};
  static inline thread_local WindowLifetimeMonitor* current_=nullptr;
  static void CALLBACK Event(HWINEVENTHOOK,DWORD event,HWND hwnd,LONG object,LONG child,DWORD,DWORD){
    if(!current_||event!=EVENT_OBJECT_DESTROY||object!=OBJID_WINDOW||child!=CHILDID_SELF)return;
    std::lock_guard<std::mutex> lock(current_->mutex_);
    const auto it=current_->watched_.find(hwnd);if(it==current_->watched_.end())return;
    for(auto& weak:it->second)if(auto flag=weak.lock())flag->store(true);
    current_->watched_.erase(it);
  }
 public:
  bool Start(){
    stopping_.store(false);
    std::promise<bool> promise;auto ready=promise.get_future();
    thread_=std::thread([this,p=std::move(promise)]() mutable {
      current_=this;thread_id_=GetCurrentThreadId();MSG msg;PeekMessageW(&msg,nullptr,WM_USER,WM_USER,PM_NOREMOVE);
      const auto hook=SetWinEventHook(EVENT_OBJECT_DESTROY,EVENT_OBJECT_DESTROY,nullptr,Event,0,0,WINEVENT_OUTOFCONTEXT|WINEVENT_SKIPOWNPROCESS);
      p.set_value(hook!=nullptr);
      if(hook){while(!stopping_.load() && GetMessageW(&msg,nullptr,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}UnhookWinEvent(hook);}
      current_=nullptr;
    });
    if(ready.wait_for(std::chrono::seconds(2))!=std::future_status::ready){Stop();return false;}
    if(!ready.get()){Stop();return false;}return true;
  }
  std::shared_ptr<Flag> Watch(HWND hwnd){
    std::lock_guard<std::mutex> lock(mutex_);
    for(auto it=watched_.begin();it!=watched_.end();){auto& v=it->second;v.erase(std::remove_if(v.begin(),v.end(),[](auto& w){return w.expired();}),v.end());if(v.empty())it=watched_.erase(it);else ++it;}
    if(watched_.size()>=128)return {};
    auto flag=std::make_shared<Flag>(false);watched_[hwnd].push_back(flag);return flag;
  }
  void Stop(){stopping_.store(true);if(thread_.joinable()){const DWORD tid=thread_id_.load();if(tid)PostThreadMessageW(tid,WM_QUIT,0,0);thread_.join();}}
  ~WindowLifetimeMonitor(){Stop();}
};
}
