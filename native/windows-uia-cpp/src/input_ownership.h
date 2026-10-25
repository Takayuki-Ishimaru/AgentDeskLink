#pragma once
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <array>
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>
#include <string>
#include <vector>
namespace adl {
// A lease-protected, user-private write-ahead journal survives a helper crash.
// Two checksummed slots retain the last complete record if a write is torn.
class InputOwnership {
 public:
  static constexpr DWORD Left=1,Ctrl=2,A=4,Back=8,Unicode=16,All=31;
 private:
  struct Record {ULONGLONG sequence;DWORD magic,version,bits,count;WORD units[16];DWORD checksum,reserved;};
  static_assert(sizeof(Record)==64&&offsetof(Record,checksum)==56,"journal record wire layout must be fixed");
  HANDLE file_=INVALID_HANDLE_VALUE;Record state_{};
  static DWORD Checksum(const Record& r){DWORD value=2166136261u;const auto* bytes=reinterpret_cast<const unsigned char*>(&r);for(size_t i=0;i<offsetof(Record,checksum);++i)value=(value^bytes[i])*16777619u;return value;}
  static bool PrivateFile(HANDLE file,const std::wstring& sid){
    PSID expected=nullptr;if(!ConvertStringSidToSidW(sid.c_str(),&expected))return false;
    PSID owner=nullptr;PACL acl=nullptr;PSECURITY_DESCRIPTOR descriptor=nullptr;
    const DWORD security=GetSecurityInfo(file,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&owner,nullptr,&acl,nullptr,&descriptor);
    bool valid=security==ERROR_SUCCESS&&owner&&EqualSid(owner,expected)&&acl&&IsValidAcl(acl);
    if(valid)for(DWORD i=0;i<acl->AceCount;++i){void* raw=nullptr;if(!GetAce(acl,i,&raw)){valid=false;break;}const auto* header=static_cast<ACE_HEADER*>(raw);
      if(header->AceType!=ACCESS_ALLOWED_ACE_TYPE||header->AceSize<offsetof(ACCESS_ALLOWED_ACE,SidStart)+8){valid=false;break;}
      PSID allowed=&static_cast<ACCESS_ALLOWED_ACE*>(raw)->SidStart;
      if(!IsValidSid(allowed)||GetLengthSid(allowed)>header->AceSize-offsetof(ACCESS_ALLOWED_ACE,SidStart)||(!EqualSid(allowed,expected)&&!IsWellKnownSid(allowed,WinLocalSystemSid))){valid=false;break;}}
    if(descriptor)LocalFree(descriptor);LocalFree(expected);BY_HANDLE_FILE_INFORMATION information{};
    return valid&&GetFileInformationByHandle(file,&information)&&information.nNumberOfLinks==1&&!(information.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY);
  }
  static bool Valid(const Record& r){return r.magic==0x41444c49u&&r.version==1&&r.sequence&&!(r.bits&~All)&&r.count<=16&&((r.bits&Unicode)?r.count>0:r.count==0)&&r.checksum==Checksum(r);}
 public:
  InputOwnership()=default;InputOwnership(const InputOwnership&)=delete;InputOwnership& operator=(const InputOwnership&)=delete;
  void Close(){if(file_!=INVALID_HANDLE_VALUE){CloseHandle(file_);file_=INVALID_HANDLE_VALUE;}}
  bool Open(const std::wstring& sid){
    wchar_t temp[MAX_PATH+1]{};const DWORD size=GetTempPathW(MAX_PATH,temp);DWORD session=0;if(!size||size>=MAX_PATH||!ProcessIdToSessionId(GetCurrentProcessId(),&session))return false;
    const std::wstring path=std::wstring(temp)+L"AgentDeskLink-InputOwner-v1-"+sid+L"-"+std::to_wstring(session)+L".state";
    PSECURITY_DESCRIPTOR descriptor=nullptr;const std::wstring dacl=L"O:"+sid+L"D:P(A;;FA;;;SY)(A;;FA;;;"+sid+L")";
    if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(dacl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))return false;
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES),descriptor,FALSE};
    file_=CreateFileW(path.c_str(),GENERIC_READ|GENERIC_WRITE,0,&security,OPEN_ALWAYS,FILE_ATTRIBUTE_HIDDEN|FILE_FLAG_WRITE_THROUGH|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);LocalFree(descriptor);
    if(file_==INVALID_HANDLE_VALUE||!PrivateFile(file_,sid))return false;
    FILE_ATTRIBUTE_TAG_INFO attributes{};LARGE_INTEGER length{};
    if(!GetFileInformationByHandleEx(file_,FileAttributeTagInfo,&attributes,sizeof attributes)||(attributes.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||!GetFileSizeEx(file_,&length)||length.QuadPart>static_cast<LONGLONG>(2*sizeof(Record)))return false;
    if(length.QuadPart==0)return Set(0,{});
    Record records[2]{};DWORD read=0;LARGE_INTEGER zero{};
    if(!SetFilePointerEx(file_,zero,nullptr,FILE_BEGIN)||!ReadFile(file_,records,sizeof records,&read,nullptr))return false;
    const bool first=read>=sizeof(Record)&&Valid(records[0]),second=read>=2*sizeof(Record)&&Valid(records[1]);
    if(!first&&!second)return false;state_=!second||(first&&records[0].sequence>records[1].sequence)?records[0]:records[1];return true;
  }
  bool Empty()const{return state_.bits==0;}
  DWORD Bits()const{return state_.bits;}
  std::vector<WORD> Units()const{return std::vector<WORD>(state_.units,state_.units+state_.count);}
  bool Set(DWORD bits,const std::vector<WORD>& units){
    if(file_==INVALID_HANDLE_VALUE||(bits&~All)||units.size()>16||((bits&Unicode)?units.empty():!units.empty())||state_.sequence==~0ULL)return false;
    Record next{};next.sequence=state_.sequence+1;next.magic=0x41444c49u;next.version=1;next.bits=bits;next.count=static_cast<DWORD>(units.size());std::copy(units.begin(),units.end(),next.units);next.checksum=Checksum(next);
    LARGE_INTEGER offset{};offset.QuadPart=static_cast<LONGLONG>((next.sequence-1)%2)*sizeof(Record);DWORD written=0;
    if(!SetFilePointerEx(file_,offset,nullptr,FILE_BEGIN)||!WriteFile(file_,&next,sizeof next,&written,nullptr)||written!=sizeof next||!FlushFileBuffers(file_))return false;state_=next;
    // Zero both durable slots after verified release, so past text units are
    // not retained in the previous recovery record.
    if(bits==0&&next.sequence<~0ULL){Record clear=next;clear.sequence++;clear.checksum=Checksum(clear);offset.QuadPart=static_cast<LONGLONG>((clear.sequence-1)%2)*sizeof(Record);written=0;
      if(!SetFilePointerEx(file_,offset,nullptr,FILE_BEGIN)||!WriteFile(file_,&clear,sizeof clear,&written,nullptr)||written!=sizeof clear||!FlushFileBuffers(file_))return false;state_=clear;}
    return true;
  }
  bool Recover(ULONG_PTR tag=0,const std::function<bool(UINT)>& observed={}){
    if(Empty())return true;std::vector<INPUT> inputs;
    auto mouse=[&]{INPUT i{};i.type=INPUT_MOUSE;i.mi.dwFlags=MOUSEEVENTF_LEFTUP;inputs.push_back(i);};
    auto key=[&](WORD code,bool unicode=false){INPUT i{};i.type=INPUT_KEYBOARD;i.ki.wVk=unicode?0:code;i.ki.wScan=unicode?code:0;i.ki.dwFlags=KEYEVENTF_KEYUP|(unicode?KEYEVENTF_UNICODE:0);inputs.push_back(i);};
    if(state_.bits&Left)mouse();if(state_.bits&Ctrl)key(VK_CONTROL);if(state_.bits&A)key('A');if(state_.bits&Back)key(VK_BACK);if(state_.bits&Unicode)for(WORD unit:Units())key(unit,true);
    for(auto& input:inputs)if(input.type==INPUT_MOUSE)input.mi.dwExtraInfo=tag;else input.ki.dwExtraInfo=tag;
    const UINT sent=SendInput(static_cast<UINT>(inputs.size()),inputs.data(),sizeof(INPUT));if(sent!=inputs.size()||(observed&&!observed(sent)))return false;
    for(int attempt=0;attempt<100;++attempt){bool held=false;if(state_.bits&Left)held|=(GetAsyncKeyState(VK_LBUTTON)&0x8000)!=0;if(state_.bits&Ctrl)held|=(GetAsyncKeyState(VK_CONTROL)&0x8000)!=0;if(state_.bits&A)held|=(GetAsyncKeyState('A')&0x8000)!=0;if(state_.bits&Back)held|=(GetAsyncKeyState(VK_BACK)&0x8000)!=0;if(!held)return Set(0,{});Sleep(2);}return false;
  }
  ~InputOwnership(){Close();}
};
}
