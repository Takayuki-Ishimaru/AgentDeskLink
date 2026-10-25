#pragma once
#include <string>
namespace adl {
// Rich Edit's UIA proxy can include the mandatory final paragraph marker.
// Never trim user data: remove exactly one CR only when the independently
// read native control text proves it is the extra structural character.
inline std::wstring LogicalValueText(const std::wstring& uia,const std::wstring& native,bool verified_rich_edit){
  if(verified_rich_edit&&uia.size()==native.size()+1&&uia.back()==L'\r'&&uia.compare(0,native.size(),native)==0)return native;
  return uia;
}
}
