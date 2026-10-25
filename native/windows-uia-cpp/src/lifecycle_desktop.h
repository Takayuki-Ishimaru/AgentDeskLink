#pragma once
#include <windows.h>
#include <string>
#include <vector>
#include "protocol.h"

namespace adl {
inline std::wstring DesktopName(HDESK desktop) {
  wchar_t name[256]{}; DWORD used=0;
  if(!desktop||!GetUserObjectInformationW(desktop,UOI_NAME,name,sizeof(name),&used)||used>sizeof(name))return {};
  return name;
}
inline bool OnLifecycleDesktop() {
  const auto own=DesktopName(GetThreadDesktop(GetCurrentThreadId()));
  if(own.size()!=36||own.compare(0,4,L"ADL-")!=0)return false;
  for(size_t i=4;i<own.size();++i)if(!((own[i]>=L'0'&&own[i]<=L'9')||(own[i]>=L'a'&&own[i]<=L'f')))return false;
  HDESK input=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
  const auto human=DesktopName(input);if(input)CloseDesktop(input);
  return !human.empty()&&_wcsicmp(own.c_str(),human.c_str())!=0;
}
inline std::wstring QuoteWindowsArgument(const std::wstring& arg) {
  std::wstring out=L"\"";size_t slashes=0;
  for(wchar_t c:arg){if(c==L'\\'){++slashes;continue;}out.append(c==L'"'?slashes*2+1:slashes,L'\\');slashes=0;out+=c;}
  out.append(slashes*2,L'\\');out+=L'"';return out;
}

// The bootstrap owns the desktop and a job containing only the UIA worker.
// Its applications silently break away: losing IPC never force-kills a document.
// Stdio inheritance is restricted to three fresh duplicate handles.
inline bool RunLifecycleWorker(int argc,wchar_t** argv,int& exit_code) {
  const auto token=NewOpaqueHandle();if(token.size()!=32)return false;
  const std::wstring name=L"ADL-"+std::wstring(token.begin(),token.end());
  HDESK desktop=CreateDesktopW(name.c_str(),nullptr,nullptr,0,
      DESKTOP_CREATEWINDOW|DESKTOP_CREATEMENU|DESKTOP_ENUMERATE|DESKTOP_READOBJECTS|DESKTOP_WRITEOBJECTS|DESKTOP_HOOKCONTROL,nullptr);
  if(!desktop)return false;
  HANDLE stdio[3]{};HANDLE job=nullptr;
  PROCESS_INFORMATION process{};bool ok=false;
  do {
    const DWORD identifiers[]={STD_INPUT_HANDLE,STD_OUTPUT_HANDLE,STD_ERROR_HANDLE};
    bool copied=true;
    for(size_t i=0;i<3;++i){HANDLE original=GetStdHandle(identifiers[i]);if(!original||original==INVALID_HANDLE_VALUE||
        !DuplicateHandle(GetCurrentProcess(),original,GetCurrentProcess(),&stdio[i],0,TRUE,DUPLICATE_SAME_ACCESS)){copied=false;break;}}
    if(!copied)break;
    job=CreateJobObjectW(nullptr,nullptr);if(!job)break;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
    if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)))break;
    wchar_t self[32768]{};const DWORD length=GetModuleFileNameW(nullptr,self,32768);
    if(!length||length>=32768)break;
    std::wstring command=QuoteWindowsArgument(self);
    for(int i=1;i<argc;++i){command+=L' ';command+=QuoteWindowsArgument(argv[i]);}
    command+=L" --lifecycle-worker";
    STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);
    startup.StartupInfo.lpDesktop=const_cast<wchar_t*>(name.c_str());
    startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES|STARTF_FORCEOFFFEEDBACK;
    startup.StartupInfo.hStdInput=stdio[0];startup.StartupInfo.hStdOutput=stdio[1];startup.StartupInfo.hStdError=stdio[2];
    // Attribute-list job assignment is atomic with creation: no orphan worker
    // can be left suspended if the bootstrap is interrupted at this boundary.
    SIZE_T job_bytes=0;InitializeProcThreadAttributeList(nullptr,2,0,&job_bytes);
    auto* both=static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(),0,job_bytes));
    if(!both)break;
    if(!InitializeProcThreadAttributeList(both,2,0,&job_bytes)){HeapFree(GetProcessHeap(),0,both);break;}
    bool assigned=UpdateProcThreadAttribute(both,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,stdio,sizeof(stdio),nullptr,nullptr)&&
      UpdateProcThreadAttribute(both,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job,sizeof(job),nullptr,nullptr);
    if(assigned){startup.lpAttributeList=both;assigned=CreateProcessW(self,command.data(),nullptr,nullptr,TRUE,
        EXTENDED_STARTUPINFO_PRESENT|CREATE_NO_WINDOW,nullptr,nullptr,&startup.StartupInfo,&process)!=FALSE;}
    DeleteProcThreadAttributeList(both);HeapFree(GetProcessHeap(),0,both);
    if(!assigned)break;
    CloseHandle(process.hThread);process.hThread=nullptr;
    for(HANDLE& h:stdio){CloseHandle(h);h=nullptr;}
    if(WaitForSingleObject(process.hProcess,INFINITE)!=WAIT_OBJECT_0)break;
    DWORD result=2;if(!GetExitCodeProcess(process.hProcess,&result))break;
    exit_code=static_cast<int>(result);ok=true;
  }while(false);
  if(process.hThread)CloseHandle(process.hThread);
  if(process.hProcess)CloseHandle(process.hProcess);
  if(job)CloseHandle(job);
  for(HANDLE h:stdio)if(h)CloseHandle(h);
  CloseDesktop(desktop);return ok;
}
} // namespace adl
