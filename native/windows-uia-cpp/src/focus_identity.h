#pragma once
#include <windows.h>
#include <oleauto.h>
#include <cstdint>
#include <cstdio>
#include <string>
#include <utility>

namespace adl {
// Runtime IDs are opaque complete integer arrays. Never truncate or use a
// released COM proxy address to certify that the focused element is unchanged.
inline bool FocusRuntimeIdentity(SAFEARRAY* array, std::string& out) {
  out.clear();
  VARTYPE type = VT_EMPTY;
  LONG lower = 0, upper = -1;
  if (!array || SafeArrayGetDim(array) != 1 ||
      FAILED(SafeArrayGetVartype(array, &type)) || type != VT_I4 ||
      SafeArrayGetElemsize(array) != sizeof(LONG) ||
      FAILED(SafeArrayGetLBound(array, 1, &lower)) ||
      FAILED(SafeArrayGetUBound(array, 1, &upper))) return false;
  const auto count = static_cast<int64_t>(upper) - lower + 1;
  if (count < 1 || count > 256) return false;
  std::string identity = "r:";
  for (int64_t offset = 0; offset < count; ++offset) {
    LONG index = static_cast<LONG>(static_cast<int64_t>(lower) + offset), value = 0;
    if (FAILED(SafeArrayGetElement(array, &index, &value))) return false;
    char hex[9];
    std::snprintf(hex, sizeof hex, "%08x", static_cast<unsigned>(value));
    identity += hex;
  }
  out = std::move(identity);
  return true;
}
} // namespace adl
