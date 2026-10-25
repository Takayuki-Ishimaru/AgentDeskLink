#pragma once
// Types and Windows-independent logic of the AgentDeskLink UIA helper.
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace adl {

using nlohmann::json;

constexpr int kMaxResponseBytes = 12 * 1024 * 1024; // visual-only response bound; input remains 64 KiB
constexpr int kMaxLineBytes = 65536;   // input and semantic snapshot bound
constexpr int kMaxValueChars = 4096;   // bound for a fill value
constexpr int kMaxTreeNodes = 1000;    // bound for one snapshot traversal
constexpr size_t kMaxTargets = 32;     // bound for simultaneous discover targets
constexpr size_t kMaxSessions = 32;    // bound for simultaneous open sessions

struct Status {
  const char* code = nullptr;  // null means success
  std::string message;
  bool may_have_executed = false;
  bool ok() const { return code == nullptr; }
  static Status Ok() { return Status(); }
  static Status Fail(const char* c, std::string m, bool may_run = false) {
    return Status{c, std::move(m), may_run};
  }
};

struct ElemInfo {
  std::string identity;  // private, never returned to the caller
  std::string id;        // opaque handle assigned per session
  std::string automation_id;
  std::string role;
  std::string name;
  std::string value;
  bool enabled = false;
  bool has_checked = false;
  bool checked = false;
  bool has_selected = false;
  bool selected = false;
  bool sensitive = false;
  bool is_password = false;
  std::string fingerprint;
};

struct SnapshotResult {
  std::vector<ElemInfo> elements;
  bool truncated = false;
};

struct ActionRequest {
  std::string element_id;
  std::string identity;       // resolved by the helper, never taken from the caller
  std::string automation_id;  // the AutomationId the handle was bound to
  std::string expected_role;  // bound by the trusted controls configuration
  std::string action;
  std::string value;
  bool has_checked = false;
  bool checked = false;
  std::string direction;
};

struct FocusProbe {
  unsigned long long foreground = 0;
  std::string focus_identity;
  long long cursor_x = 0;
  long long cursor_y = 0;
};

// Result of the session-less application lifecycle op. Only these three facts
// are ever reported: no window, process or path information leaves the helper.
struct ApplicationResult {
  bool running = false;  // the configured application is running
  bool managed = false;  // it is running because this helper launched it
  bool changed = false;  // this request changed that state
};

struct Session;
struct Backend;
struct ControlsTable;

// One window as the backend observed it. Identity is exactly
// (window_key, process_start, root_token); label and geometry never route.
struct TargetObservation {
  unsigned long long window_key = 0;     // native window handle, opaque
  unsigned long long process_start = 0;  // process start time, from the retained handle
  std::string root_token;                // changes when the root element changes
  std::string label;                     // window title, display only
  long long x = 0, y = 0;                // desktop physical pixels, signed
  long long width = 0, height = 0;
  std::vector<std::string> display_ids;  // opaque display labels
  bool minimized = false;
};

struct TargetEntry {
  std::string target_id;
  unsigned long long window_key = 0;
  unsigned long long process_start = 0;
  std::string root_token;
  std::string label;
  long long x = 0, y = 0;
  long long width = 0, height = 0;
  std::vector<std::string> display_ids;
  bool minimized = false;
};

// Stable opaque target ids over repeated enumerations. An id survives title,
// position, size and display changes; it is dropped when the window closes or
// its root element changes, and a recreated window gets a new id. Dropped ids
// are never reused because fresh ids are random.
class TargetRegistry {
 public:
  Status Synchronize(const std::vector<TargetObservation>& observations,
                     std::vector<TargetEntry>& out_entries);
  const TargetEntry* Find(const std::string& target_id) const;  // live entries only
  size_t live_count() const { return live_.size(); }

 private:
  std::vector<TargetEntry> live_;
};

// Multi-target, multi-session request context. Sessions are bounded and each
// belongs to exactly one target; closing one session never shuts the helper.
struct Broker {
  TargetRegistry registry;
  std::map<std::string, std::unique_ptr<Session>> sessions;  // session_id -> session
  std::string app_id;
  void CloseAll(const Backend& b);
};

// UIA backend as function pointers so the protocol is testable off Windows.
struct Backend {
  void* ctx = nullptr;
  Status (*discover)(void* ctx, bool& out_available, std::string& out_app_id);
  Status (*bind)(void* ctx, Session&);
  Status (*revalidate)(void* ctx, Session&);
  Status (*snapshot)(void* ctx, Session&, SnapshotResult&);
  Status (*act)(void* ctx, Session&, const ActionRequest&, std::string& out_detail);
  Status (*probe)(void* ctx, Session&, FocusProbe&);
  void (*close)(void* ctx, Session&);
  Status (*enumerate_targets)(void* ctx, std::vector<TargetObservation>& out,
                              std::string& out_app_id) = nullptr;
  Status (*input_operation)(void* ctx, Session&, const json&, const ControlsTable&, json& result) = nullptr;
  std::vector<std::string> gesture_backends;
  Status (*capture)(void* ctx, Session&, json& result) = nullptr; // null unless launch-time opt-in
  // Application lifecycle (status/launch/quit) of the configured executable. Null
  // unless the trusted --lifecycle-enabled launch flag opted in; the protocol never
  // dispatches without it and never accepts a target, PID, path or command.
  Status (*application)(void* ctx, const std::string& action, ApplicationResult& result) = nullptr;
};

struct Session {
  std::string session_id;
  std::string target_id;
  std::string app_id;
  std::string app_path;
  std::string mode = "background_semantic";
  std::string binding_token;  // private exact root generation from target registry
  unsigned long pid = 0;
  unsigned long long start_time = 0;
  unsigned long long hwnd = 0;
  void* impl = nullptr;  // backend private state
  long long revision = 0;
  bool has_revision = false;
  bool invalidated = false;
  bool open = false;
  std::string tree_fingerprint;
  std::vector<ElemInfo> elements;               // last snapshot, tree order
  std::map<std::string, std::string> id_by_identity;
  long long next_element_id = 0;
};

struct ControlsTable {
  struct Policy {
    std::string role;
    std::vector<std::string> actions;
  };
  std::map<std::string, Policy> allowed;
  // Trusted --allow-all launch mode: supported actions on any observed, enabled
  // control are permitted without an allowlist entry. Set only from argv.
  bool allow_all = false;
};

// --- pure logic (protocol.cpp) ---
bool LoadControls(const nlohmann::json& doc, ControlsTable& out, std::string& err);
bool ActionAllowed(const ControlsTable&, const std::string& automation_id, const std::string& action);
std::string ExpectedRole(const ControlsTable&, const std::string& automation_id);
bool IsSensitiveText(const std::string& text);
bool IsBlockedControl(const ElemInfo&);
std::string NewOpaqueHandle();
std::string Redact(const std::string& text);
std::string ElementFingerprint(const ElemInfo&);
nlohmann::json ElementJson(const ElemInfo&);
void ApplySnapshot(Session&, SnapshotResult&);  // ids, revision, redaction
// Legacy single-target, single-session route (protocol V1 shape).
std::string HandleRequest(const std::string& line, Session&, const Backend&, const ControlsTable&,
                          bool& shutdown);
// V2 route: discover and open go through the broker registry; snapshot, act and
// close address one exact target plus session.
std::string HandleRequest(const std::string& line, Broker&, const Backend&, const ControlsTable&,
                          bool& shutdown);

}  // namespace adl
