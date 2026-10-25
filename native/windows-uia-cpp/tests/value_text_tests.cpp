#include "value_text.h"
#include <iostream>
#include <vector>
int main(){
  struct Case{const char* name;std::wstring uia,native,want;bool verified;};
  const std::vector<Case> cases={
    {"empty Rich Edit paragraph",L"\r",L"",L"",true},
    {"Unicode value",L"AgentDeskLink 日本語\r",L"AgentDeskLink 日本語",L"AgentDeskLink 日本語",true},
    {"intentional final CR stays",L"text\r\r",L"text\r",L"text\r",true},
    {"multiple empty paragraphs stay",L"\r\r\r",L"\r\r",L"\r\r",true},
    {"ordinary edit is not normalized",L"text\r",L"text",L"text\r",false},
    {"native disagreement is not hidden",L"text\r",L"different",L"text\r",true},
    {"line-ending conversion is not guessed",L"a\rb\r",L"a\r\nb",L"a\rb\r",true},
    {"no extra marker",L"text",L"text",L"text",true},
    {"empty ordinary value",L"",L"",L"",false},
    {"CRLF data stays",L"a\r\n\r",L"a\r\n",L"a\r\n",true},
    {"bounded maximum data",std::wstring(4096,L'x')+L"\r",std::wstring(4096,L'x'),std::wstring(4096,L'x'),true}
  };
  for(const auto& c:cases)if(adl::LogicalValueText(c.uia,c.native,c.verified)!=c.want){std::cerr<<"FAIL "<<c.name<<'\n';return 1;}
  std::cout<<"all "<<cases.size()<<" Rich Edit value contract tests passed\n";
}
