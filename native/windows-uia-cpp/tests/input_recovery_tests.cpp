#include <windows.h>
#include <cstdio>
#include <string>
#include <aclapi.h>
#include "input_monitor.h"
int main(int argc,char** argv){
  if(argc==3&&std::string(argv[1])=="--interactive-hold"){
    const auto target=reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(argv[2])));POINT cursor{};
    if(!target||GetForegroundWindow()!=target||!GetCursorPos(&cursor)||GetAncestor(WindowFromPoint(cursor),GA_ROOT)!=target||!adl::NoHeldInput())return 2;
    adl::InputLease lease;adl::InputMonitor monitor;if(!lease.Acquire()||!monitor.Start())return 3;
    if(!lease.Journal().Set(adl::InputOwnership::Left|adl::InputOwnership::Ctrl|adl::InputOwnership::A,{}))return 4;
    INPUT down[3]{};down[0].type=INPUT_MOUSE;down[0].mi.dwFlags=MOUSEEVENTF_LEFTDOWN;down[0].mi.dwExtraInfo=monitor.Tag();
    down[1].type=INPUT_KEYBOARD;down[1].ki.wVk=VK_CONTROL;down[1].ki.dwExtraInfo=monitor.Tag();down[2].type=INPUT_KEYBOARD;down[2].ki.wVk='A';down[2].ki.dwExtraInfo=monitor.Tag();
    const auto before=monitor.OwnSequence();if(SendInput(3,down,sizeof(INPUT))!=3||!monitor.AwaitOwn(before+3))return 5;
    std::puts("OWNED_READY");std::fflush(stdout);Sleep(30000);
    return lease.Journal().Recover()?0:6;
  }
  wchar_t original_temp[MAX_PATH+1]{};if(!GetTempPathW(MAX_PATH,original_temp))return 1;
  const std::wstring directory=std::wstring(original_temp)+L"ADL-Recovery-Contract-"+std::to_wstring(GetCurrentProcessId());if(!CreateDirectoryW(directory.c_str(),nullptr))return 1;
  SetEnvironmentVariableW(L"TEMP",directory.c_str());SetEnvironmentVariableW(L"TMP",directory.c_str());
  HANDLE token=nullptr;DWORD bytes=0;OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token);GetTokenInformation(token,TokenUser,nullptr,0,&bytes);std::vector<unsigned char> user(bytes);if(!GetTokenInformation(token,TokenUser,user.data(),bytes,&bytes)){CloseHandle(token);return 1;}CloseHandle(token);
  LPWSTR raw_sid=nullptr;if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid,&raw_sid))return 1;const std::wstring sid=raw_sid;LocalFree(raw_sid);DWORD session=0;ProcessIdToSessionId(GetCurrentProcessId(),&session);
  const std::wstring state_path=directory+L"\\AgentDeskLink-InputOwner-v1-"+sid+L"-"+std::to_wstring(session)+L".state";
  int failures=0,cases=0;auto check=[&](bool ok,const char* name){++cases;std::printf("%s %s\n",ok?"PASS":"FAIL",name);if(!ok)++failures;};
  {adl::InputLease lease;if(!lease.Acquire()){std::puts("FAIL clean lease/journal");return 1;}auto& journal=lease.Journal();check(journal.Empty(),"new or clean journal is empty");check(journal.Recover(),"empty recovery is a no-op");
  check(!journal.Set(32,{}),"unknown ownership bits refused");check(!journal.Set(adl::InputOwnership::Unicode,{}),"Unicode ownership needs bounded units");check(!journal.Set(adl::InputOwnership::Left,{65}),"non-Unicode ownership cannot carry units");check(!journal.Set(adl::InputOwnership::Unicode,std::vector<WORD>(17,65)),"Unicode journal bound enforced");
  check(journal.Set(adl::InputOwnership::Ctrl|adl::InputOwnership::A,{}),"write-ahead key ownership persisted");check(journal.Bits()==(adl::InputOwnership::Ctrl|adl::InputOwnership::A),"only declared key ownership recorded");check(journal.Set(0,{}),"verified release clears journal");
  check(journal.Set(adl::InputOwnership::Unicode,{0xd83d,0xde80}),"Unicode surrogate units retained without text logging");check(journal.Units()==std::vector<WORD>({0xd83d,0xde80}),"Unicode recovery units exact");check(journal.Set(0,{}),"final journal clean");
  }
  const std::wstring hardlink=directory+L"\\hardlink.state";check(CreateHardLinkW(hardlink.c_str(),state_path.c_str(),nullptr)!=FALSE,"hardlink fixture created");{adl::InputOwnership candidate;check(!candidate.Open(sid),"multiply-linked journal rejected before input");}DeleteFileW(hardlink.c_str());
  PSECURITY_DESCRIPTOR broad=nullptr;PACL acl=nullptr;BOOL present=FALSE,defaults=FALSE;
  check(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;FA;;;WD)",SDDL_REVISION_1,&broad,nullptr)!=FALSE,"broad DACL fixture parsed");
  if(broad){GetSecurityDescriptorDacl(broad,&present,&acl,&defaults);check(SetNamedSecurityInfoW(const_cast<wchar_t*>(state_path.c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,acl,nullptr)==ERROR_SUCCESS,"broad DACL fixture applied");LocalFree(broad);{adl::InputOwnership candidate;check(!candidate.Open(sid),"preexisting broad DACL journal rejected before input");}}
  PSECURITY_DESCRIPTOR private_descriptor=nullptr;const std::wstring private_sddl=L"D:P(A;;FA;;;SY)(A;;FA;;;"+sid+L")";
  if(ConvertStringSecurityDescriptorToSecurityDescriptorW(private_sddl.c_str(),SDDL_REVISION_1,&private_descriptor,nullptr)){GetSecurityDescriptorDacl(private_descriptor,&present,&acl,&defaults);check(SetNamedSecurityInfoW(const_cast<wchar_t*>(state_path.c_str()),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,acl,nullptr)==ERROR_SUCCESS,"private DACL restored for record tests");LocalFree(private_descriptor);}
  std::vector<unsigned char> valid_record(128);DWORD transferred=0;HANDLE source=CreateFileW(state_path.c_str(),GENERIC_READ,0,nullptr,OPEN_EXISTING,0,nullptr);check(source!=INVALID_HANDLE_VALUE&&ReadFile(source,valid_record.data(),128,&transferred,nullptr)&&transferred==128,"fixed journal record fixture read");if(source!=INVALID_HANDLE_VALUE)CloseHandle(source);
  auto rewrite=[&](DWORD bits,DWORD count,bool corrupt){auto data=valid_record;for(size_t offset:{size_t(0),size_t(64)}){std::memcpy(data.data()+offset+16,&bits,4);std::memcpy(data.data()+offset+20,&count,4);DWORD checksum=2166136261u;for(size_t n=0;n<56;++n)checksum=(checksum^data[offset+n])*16777619u;if(corrupt)checksum^=1;std::memcpy(data.data()+offset+56,&checksum,4);}HANDLE file=CreateFileW(state_path.c_str(),GENERIC_WRITE,0,nullptr,TRUNCATE_EXISTING,0,nullptr);DWORD written=0;const bool ok=file!=INVALID_HANDLE_VALUE&&WriteFile(file,data.data(),128,&written,nullptr)&&written==128&&FlushFileBuffers(file);if(file!=INVALID_HANDLE_VALUE)CloseHandle(file);return ok;};
  check(rewrite(32,0,false),"unknown-bit journal record written with valid checksum");{adl::InputOwnership candidate;check(!candidate.Open(sid),"unknown-bit persisted record rejected before input");}
  check(rewrite(adl::InputOwnership::Unicode,17,false),"oversized Unicode persisted record written");{adl::InputOwnership candidate;check(!candidate.Open(sid),"oversized persisted Unicode record rejected before input");}
  check(rewrite(0,0,true),"corrupt journal fixture written");{adl::InputOwnership candidate;check(!candidate.Open(sid),"bad-checksum persisted record rejected before input");}
  DeleteFileW(state_path.c_str());RemoveDirectoryW(directory.c_str());SetEnvironmentVariableW(L"TEMP",original_temp);SetEnvironmentVariableW(L"TMP",original_temp);
  std::printf("%d/%d passed\n",cases-failures,cases);return failures?1:0;
}
