#pragma once
// UIA backend factory. The implementation is Windows only (uia_backend.cpp).
#include <string>
#include <atomic>

#include "protocol.h"

namespace adl {

// Target discovery breadth is independent from permission to mutate arbitrary
// controls. --all-apps only opts into enumerating other applications.
inline bool BroadTargetEnumeration(bool all_apps, bool allow_all, bool restrict_targets) {
  return all_apps || (allow_all && !restrict_targets);
}

// Launch-time facts, taken only from our own command line; the caller of the
// protocol can never supply a PID or an OS handle.
struct LaunchConfig {
  std::string app_id;
  std::atomic<bool>* input_cancelled = nullptr;
  json interactive_config = json::object();
  bool visual_enabled = false; // trusted launch option, never a protocol request
  bool lifecycle_enabled = false;
  bool allow_all = false;  // trusted launch option, never a protocol request
  bool all_apps = false;   // trusted launch option: discovery breadth only
  bool restrict_targets = false; // keep configured app boundary with broad control permissions
  std::string operation_mode;  // "standard" / "ask" tier (argv only), else empty
  std::string app_path;  // absolute, canonicalised
};

// Opaque backend handle (Impl*); returns a backend whose calls fail with
// E_UIA_INIT when the host has no UI Automation.
Backend MakeWindowsBackend(void* impl);
void* CreateBackendImpl(const LaunchConfig&);
void DestroyBackendImpl(void* impl);

}  // namespace adl
