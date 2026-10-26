#pragma once
// UIA backend factory. The implementation is Windows only (uia_backend.cpp).
#include <string>
#include <atomic>

#include "protocol.h"

namespace adl {

// Launch-time facts, taken only from our own command line; the caller of the
// protocol can never supply a PID or an OS handle.
struct LaunchConfig {
  std::string app_id;
  std::atomic<bool>* input_cancelled = nullptr;
  json interactive_config = json::object();
  bool visual_enabled = false; // trusted launch option, never a protocol request
  bool lifecycle_enabled = false;
  bool allow_all = false;  // trusted launch option, never a protocol request
  bool restrict_targets = false; // keep configured app boundary with broad control permissions
  std::string app_path;  // absolute, canonicalised
};

// Opaque backend handle (Impl*); returns a backend whose calls fail with
// E_UIA_INIT when the host has no UI Automation.
Backend MakeWindowsBackend(void* impl);
void* CreateBackendImpl(const LaunchConfig&);
void DestroyBackendImpl(void* impl);

}  // namespace adl
