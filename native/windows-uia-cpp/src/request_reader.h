#pragma once
#include <windows.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <istream>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include "protocol.h"
namespace adl {
// One bounded reader may recognize cancellation while the MTA driver is busy.
// It never accesses COM, the broker registry, or UI state.
class RequestReader {
 public:struct Request{std::string line,id;bool too_long=false,cancelled=false;};
 private:
  std::istream& input_;std::atomic<bool>& cancel_;std::mutex mutex_;std::condition_variable changed_;
  std::deque<Request> queue_;std::thread thread_;std::atomic<bool> stopping_{false};bool eof_=false,overflow_=false;std::string active_;std::set<std::string> pre_aborted_;
  bool Read(Request& out){int ch;bool any=false;while(!stopping_&&(ch=input_.get())!=std::istream::traits_type::eof()){any=true;if(ch=='\n')break;if(out.line.size()<kMaxLineBytes)out.line.push_back(static_cast<char>(ch));else out.too_long=true;}return any;}
 public:
  RequestReader(std::istream& input,std::atomic<bool>& cancel):input_(input),cancel_(cancel){thread_=std::thread([this]{
    Request request;while(!stopping_&&Read(request)){
      json doc;try{if(!request.too_long)doc=json::parse(request.line);}catch(...){}
      if(doc.is_object()&&doc.contains("request_id")&&doc["request_id"].is_string())request.id=doc["request_id"].get<std::string>();
      std::lock_guard<std::mutex> lock(mutex_);
      if(doc.is_object()&&doc.size()==2&&doc.contains("op")&&doc["op"].is_string()&&doc["op"].get<std::string>()=="cancel_input"&&!request.id.empty()&&request.id.size()<=128){
        if(active_==request.id)cancel_=true;
        else {bool found=false;for(auto& queued:queue_)if(queued.id==request.id){queued.cancelled=true;found=true;}
          if(!found&&!pre_aborted_.count(request.id)){if(pre_aborted_.size()>=64){overflow_=true;cancel_=true;break;}pre_aborted_.insert(request.id);}}

      }else if(queue_.size()<64){if(pre_aborted_.erase(request.id))request.cancelled=true;queue_.push_back(std::move(request));changed_.notify_one();}
      else{overflow_=true;cancel_=true;break;}
      request=Request{};
    }
    {std::lock_guard<std::mutex> lock(mutex_);eof_=true;cancel_=true;changed_.notify_all();}
  });}
  bool Next(Request& out){std::unique_lock<std::mutex> lock(mutex_);changed_.wait(lock,[this]{return !queue_.empty()||eof_;});if(overflow_||queue_.empty())return false;out=std::move(queue_.front());queue_.pop_front();active_=out.id;cancel_=out.cancelled||eof_;return true;}
  void Finished(){std::lock_guard<std::mutex> lock(mutex_);active_.clear();}
  ~RequestReader(){stopping_=true;if(thread_.joinable()){CancelSynchronousIo(thread_.native_handle());thread_.join();}}
};
}
