#include "focus_identity.h"
#include <cstdio>
#include <limits>

int main() {
  int failures = 0, cases = 0;
  auto check = [&](bool value, const char* name) { ++cases; std::printf("%s %s\n", value ? "PASS" : "FAIL", name); if (!value) ++failures; };
  std::string out = "old";
  check(!adl::FocusRuntimeIdentity(nullptr, out) && out.empty(), "missing runtime ID denied and previous value cleared");
  auto array = SafeArrayCreateVector(VT_I4, -7, 25);
  for (LONG offset=0;offset<25;++offset) { LONG index=offset-7, value=offset; SafeArrayPutElement(array,&index,&value); }
  check(adl::FocusRuntimeIdentity(array,out) && out.size()==202, "complete runtime ID beyond old 24-integer cap accepted");
  const auto before=out; LONG index=17,value=999; SafeArrayPutElement(array,&index,&value);
  check(adl::FocusRuntimeIdentity(array,out) && out!=before, "last runtime ID integer changes the identity");
  SafeArrayDestroy(array);
  array=SafeArrayCreateVector(VT_I8,0,3);
  check(!adl::FocusRuntimeIdentity(array,out) && out.empty(), "wrong array element type denied"); SafeArrayDestroy(array);
  SAFEARRAYBOUND dims[2]={{2,0},{2,0}}; array=SafeArrayCreate(VT_I4,2,dims);
  check(!adl::FocusRuntimeIdentity(array,out), "multidimensional runtime ID denied"); SafeArrayDestroy(array);
  array=SafeArrayCreateVector(VT_I4,0,0);
  check(!adl::FocusRuntimeIdentity(array,out), "empty runtime ID denied"); if(array)SafeArrayDestroy(array);
  array=SafeArrayCreateVector(VT_I4,0,257);
  check(!adl::FocusRuntimeIdentity(array,out), "oversized runtime ID denied instead of truncated"); SafeArrayDestroy(array);
  array=SafeArrayCreateVector(VT_I4,std::numeric_limits<LONG>::max(),1);
  index=std::numeric_limits<LONG>::max();value=-1;SafeArrayPutElement(array,&index,&value);
  check(adl::FocusRuntimeIdentity(array,out) && out=="r:ffffffff", "maximum signed array index and negative integer preserved"); SafeArrayDestroy(array);
  std::printf("%d/%d passed\n",cases-failures,cases);
  return failures ? 1 : 0;
}
