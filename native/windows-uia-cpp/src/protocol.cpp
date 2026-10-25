#include "protocol.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <thread>
#include <cstring>
#include <iomanip>
#include <random>
#include <sstream>
#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#endif

namespace adl {
namespace {

const char* const kOps[] = {"discover", "open", "snapshot", "act", "close", "capture", "gesture", "prepare_input", "commit_input", "application"};
constexpr size_t kOpsCount = sizeof(kOps) / sizeof(kOps[0]);
const char* const kActions[] = {"fill", "click", "select", "check", "scroll"};
const char* const kApplicationActions[] = {"status", "launch", "quit"};
constexpr size_t kApplicationActionCount = sizeof(kApplicationActions) / sizeof(kApplicationActions[0]);
const char* const kDirections[] = {"up", "down"};

// Token match; a trailing '*' means prefix match.
const char* const kSensitive[] = {"password", "passwd", "pwd", "pin",    "otp",      "secret",
                                  "token*",   "credential*", "ssn",      "cvv",      "cardnumber",
                                  "creditcard", "apikey",    "privatekey", "authcode", "passcode"};
const char* const kBlocked[] = {"delete",  "remove",  "destroy", "submit", "send",   "pay",
                                "purchase", "buy",     "order",   "install", "uninstall", "run",
                                "execute", "admin*",  "elevate", "elevation", "shutdown", "restart",
                                "reboot",  "format",  "wipe",    "close",  "exit",   "quit",
                                "file",    "browse*", "security", "secure", "uac",   "permission*",
                                "grant",   "allow",   "trust",   "yes",    "no",     "ok",
                                "save*",   "overwrite", "replace", "continue", "protect", "unlock",
                                "sign",    "payment", "wallet", "cryptographic"};

std::string Lower(const std::string& s) {
  std::string o = s;
  std::transform(o.begin(), o.end(), o.begin(), [](unsigned char c) { return (char)std::tolower(c); });
  return o;
}

std::vector<std::string> Tokens(const std::string& lower) {
  std::vector<std::string> out;
  std::string cur;
  for (char c : lower) {
    if (std::isalnum((unsigned char)c)) {
      cur.push_back(c);
    } else if (!cur.empty()) {
      out.push_back(cur);
      cur.clear();
    }
  }
  if (!cur.empty()) out.push_back(cur);
  return out;
}

bool MatchesSet(const std::string& text, const char* const* set, size_t n) {
  std::string compact;
  for (char c : Lower(text))
    if (std::isalnum((unsigned char)c)) compact.push_back(c);
  for (size_t i = 0; i < n; ++i) {
    std::string key;
    for (char c : std::string(set[i]))
      if (c != '*') key.push_back(c);
    if (!key.empty() && compact.find(key) != std::string::npos) return true;
  }
  for (const std::string& tok : Tokens(Lower(text))) {
    for (size_t i = 0; i < n; ++i) {
      const std::string e = set[i];
      if (e.empty()) continue;
      if (e.back() == '*') {
        if (tok.size() >= e.size() - 1 && tok.compare(0, e.size() - 1, e, 0, e.size() - 1) == 0)
          return true;
      } else if (tok == e) {
        return true;
      }
    }
  }
  return false;
}

bool InList(const char* const* list, size_t n, const std::string& v) {
  for (size_t i = 0; i < n; ++i)
    if (v == list[i]) return true;
  return false;
}

std::string RandomHex(size_t bytes) {
  std::vector<unsigned char> raw(bytes);
#ifdef _WIN32
  if (BCryptGenRandom(nullptr, raw.data(), static_cast<ULONG>(raw.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
    return std::string();
#else
  std::random_device rd;
  for (auto& b : raw) b = static_cast<unsigned char>(rd());
#endif
  std::ostringstream os;
  for (unsigned char b : raw) os << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned>(b);
  return os.str();
}

using nlohmann::json;

std::string Ok(const json& rid, const json& result) {
  return json{{"ok", true}, {"request_id", rid}, {"result", result}}.dump();
}

std::string Err(const json& rid, const char* code, const std::string& msg, bool may_have_executed = false) {
  json error = {{"code", code}, {"message", msg}};
  if (may_have_executed) error["may_have_executed"] = true;
  return json{{"ok", false}, {"request_id", rid}, {"error", error}}.dump();
}

std::string StatusErr(const Status& s) {
  return s.message.empty() ? std::string(s.code) : s.message;
}

bool GetString(const json& o, const char* key, std::string& out, std::string& err) {
  if (!o.contains(key) || !o.at(key).is_string()) {
    err = std::string("missing or non-string '") + key + "'";
    return false;
  }
  out = o.at(key).get<std::string>();
  if (out.find('\0') != std::string::npos) {
    err = std::string("'") + key + "' must not contain NUL";
    return false;
  }
  return true;
}

}  // namespace

bool LoadControls(const json& doc, ControlsTable& out, std::string& err) {
  if (!doc.is_object()) {
    err = "controls file must be a JSON object";
    return false;
  }
  for (auto it = doc.begin(); it != doc.end(); ++it) {
    const std::string id = it.key();
    if (id.empty() || id.size() > 256 || id.find('\0') != std::string::npos) {
      err = "invalid AutomationId key";
      return false;
    }
    if (!it.value().is_object() || it.value().size() != 2 || !it.value().contains("allowed") ||
        !it.value().contains("role") || !it.value().at("role").is_string()) {
      err = "entry for '" + id + "' must contain only role and allowed";
      return false;
    }
    const std::string role = it.value().at("role").get<std::string>();
    const char* const roles[] = {"button", "checkbox", "edit", "listitem", "radiobutton", "pane"};
    if (!InList(roles, sizeof(roles) / sizeof(*roles), role)) {
      err = "unsupported control role for '" + id + "'";
      return false;
    }
    const json& a = it.value().at("allowed");
    if (!a.is_array() || a.empty()) {
      err = "'allowed' for '" + id + "' must be a non-empty array";
      return false;
    }
    std::vector<std::string> acts;
    for (const json& v : a) {
      if (!v.is_string() || !InList(kActions, 5, v.get<std::string>())) {
        err = "unknown action for '" + id + "'";
        return false;
      }
      if (std::find(acts.begin(), acts.end(), v.get<std::string>()) == acts.end())
        acts.push_back(v.get<std::string>());
    }
    out.allowed[id] = ControlsTable::Policy{role, acts};
  }
  return true;
}

bool ActionAllowed(const ControlsTable& t, const std::string& automation_id, const std::string& action) {
  auto it = t.allowed.find(automation_id);
  if (it == t.allowed.end()) return false;
  return std::find(it->second.actions.begin(), it->second.actions.end(), action) != it->second.actions.end();
}

std::string ExpectedRole(const ControlsTable& t, const std::string& automation_id) {
  const auto it = t.allowed.find(automation_id);
  return it == t.allowed.end() ? std::string() : it->second.role;
}

bool IsSensitiveText(const std::string& text) {
  return MatchesSet(text, kSensitive, sizeof(kSensitive) / sizeof(*kSensitive));
}

bool IsBlockedControl(const ElemInfo& e) {
  if (e.is_password) return true;
  return MatchesSet(e.automation_id + " " + e.name + " " + e.role, kBlocked,
                    sizeof(kBlocked) / sizeof(*kBlocked));
}

std::string NewOpaqueHandle() { return RandomHex(16); }

std::string Redact(const std::string& text) { return text.empty() ? std::string() : "[redacted]"; }

std::string ElementFingerprint(const ElemInfo& e) {
  return json::array({e.identity,e.automation_id,e.role,e.name,e.value,e.enabled,
                     e.has_checked,e.checked,e.has_selected,e.selected,e.sensitive,e.is_password}).dump();
}

json ElementJson(const ElemInfo& e) {
  json j;
  j["id"] = e.id;
  j["role"] = e.role;
  j["name"] = e.name;
  j["value"] = e.value;
  j["enabled"] = e.enabled;
  if (e.has_checked) j["checked"] = e.checked;
  if (e.has_selected) j["selected"] = e.selected;
  if (e.sensitive) j["sensitive"] = true;
  return j;
}

void ApplySnapshot(Session& s, SnapshotResult& snap) {
  std::ostringstream combined;
  std::map<std::string, std::string> next_ids;
  for (ElemInfo& e : snap.elements) {
    e.sensitive = e.sensitive || e.is_password || IsSensitiveText(e.automation_id) || IsSensitiveText(e.name) || IsSensitiveText(e.value);
    // Revision signatures cover the structured provider values before any
    // client-facing redaction. The signature and raw data stay process-local.
    e.fingerprint = ElementFingerprint(e);
    combined << e.fingerprint << '\n';
    e.is_password ? e.value.clear() : void();
    if (e.sensitive) {
      e.value.clear();
      e.name = Redact(e.name);
    }
    // Bound UTF-8 at character boundaries after computing the private signature.
    for (auto* field : {&e.name, &e.value}) {
      if (field->size() > 512) {
        size_t end = 512;
        while (end > 0 && (static_cast<unsigned char>((*field)[end]) & 0xc0) == 0x80) --end;
        field->resize(end);
        snap.truncated = true;
      }
    }
    if (!e.identity.empty()) {
      auto it = s.id_by_identity.find(e.identity);
      if (it == s.id_by_identity.end())
        it = s.id_by_identity.emplace(e.identity, "e-" + RandomHex(16)).first;
      e.id = it->second;
    } else {
      e.id = "e-" + RandomHex(16);
    }
    if (!e.identity.empty()) next_ids.emplace(e.identity, e.id);
  }
  s.id_by_identity.swap(next_ids);
  const std::string fp = combined.str();
  if (!s.has_revision || fp != s.tree_fingerprint) {
    s.revision = s.has_revision ? s.revision + 1 : 1;
    s.has_revision = true;
    s.tree_fingerprint = fp;
  }
  s.elements = snap.elements;
}

namespace {
// One act exchange: fresh snapshot, revision gate, policy gates, focus probes.
std::string DoAct(const json& rid, const json& doc, Session& s, const Backend& b,
                  const ControlsTable& c) {
  std::string err;
  ActionRequest a;
  if (!GetString(doc, "element_id", a.element_id, err) || !GetString(doc, "action", a.action, err))
    return Err(rid, "E_BAD_REQUEST", err);
  if (!InList(kActions, 5, a.action)) return Err(rid, "E_BAD_REQUEST", "unsupported action");
  if (!doc.contains("expected_revision") || !doc.at("expected_revision").is_number_integer())
    return Err(rid, "E_BAD_REQUEST", "expected_revision must be an integer");
  long long expected = 0;
  try {
    expected = doc.at("expected_revision").get<long long>();
  } catch (const std::exception&) {
    return Err(rid, "E_BAD_REQUEST", "expected_revision is out of range");
  }
  if (doc.contains("value")) {
    if (!doc.at("value").is_string()) return Err(rid, "E_BAD_REQUEST", "value must be a string");
    a.value = doc.at("value").get<std::string>();
  }
  if (doc.contains("checked")) {
    if (!doc.at("checked").is_boolean()) return Err(rid, "E_BAD_REQUEST", "checked must be a boolean");
    a.has_checked = true;
    a.checked = doc.at("checked").get<bool>();
  }
  if (doc.contains("direction")) {
    if (!doc.at("direction").is_string() ||
        !InList(kDirections, 2, a.direction = doc.at("direction").get<std::string>()))
      return Err(rid, "E_BAD_REQUEST", "direction must be up or down");
  }
  if (a.action == "fill" && !doc.contains("value"))
    return Err(rid, "E_BAD_REQUEST", "fill requires a string 'value'");
  if (a.action == "fill" && a.value.find('\0') != std::string::npos)
    return Err(rid, "E_BAD_REQUEST", "value must not contain NUL");
  if (a.action == "fill" && a.value.size() > kMaxValueChars)
    return Err(rid, "E_BAD_REQUEST", "value exceeds 4096 UTF-8 bytes");
  if (a.action != "fill" && doc.contains("value"))
    return Err(rid, "E_BAD_REQUEST", "value is only valid for fill");
  if (a.action == "check" && !a.has_checked)
    return Err(rid, "E_BAD_REQUEST", "check requires a boolean 'checked'");
  if (a.action != "check" && doc.contains("checked"))
    return Err(rid, "E_BAD_REQUEST", "checked is only valid for check");
  if (a.action == "scroll" && a.direction.empty())
    return Err(rid, "E_BAD_REQUEST", "scroll requires 'direction'");
  if (a.action != "scroll" && doc.contains("direction"))
    return Err(rid, "E_BAD_REQUEST", "direction is only valid for scroll");

  SnapshotResult fresh;
  Status fresh_status = b.snapshot(b.ctx, s, fresh);
  if (!fresh_status.ok()) return Err(rid, fresh_status.code, StatusErr(fresh_status));
  ApplySnapshot(s, fresh);
  if (expected != s.revision) return Err(rid, "E_STALE_REVISION", "expected_revision is stale");

  const ElemInfo* found = nullptr;
  for (const ElemInfo& e : s.elements)
    if (e.id == a.element_id) found = &e;
  if (!found) return Err(rid, "E_NO_ELEMENT", "unknown element handle");
  if (!c.allow_all) {
    if (found->sensitive || IsBlockedControl(*found))
      return Err(rid, "E_CONTROL_BLOCKED", "control is not eligible for semantic mutation");
    if (!ActionAllowed(c, found->automation_id, a.action))
      return Err(rid, "E_NOT_ALLOWED", "action not allowed for this control");
    a.expected_role = ExpectedRole(c, found->automation_id);
    if (a.expected_role.empty() || found->role != a.expected_role)
      return Err(rid, "E_CONTROL_TYPE_MISMATCH", "control type does not match its trusted configuration");
  } else {
    // Trusted allow-all: no allowlist entry, label or role configuration is
    // required, so the expected role is the latest observed role and the
    // backend still validates the actual UIA role and patterns.
    a.expected_role = found->role;
  }
  if (!found->enabled) return Err(rid, "E_NOT_ENABLED", "control is disabled");
  a.identity = found->identity;
  a.automation_id = found->automation_id;

  FocusProbe before, after;
  Status st = b.probe(b.ctx, s, before);
  if (!st.ok()) return Err(rid, st.code, StatusErr(st));
  std::string detail;
  st = b.act(b.ctx, s, a, detail);
  Status act_status = st;
  // Providers may enqueue an asynchronous handler after Invoke returns.
  // Observe the bounded completion interval; never replay the semantic action.
  const auto settled=std::chrono::steady_clock::now()+std::chrono::milliseconds(act_status.ok()||act_status.may_have_executed ? 100 : 0);
  for (;;) {
    Status post_probe=b.probe(b.ctx,s,after);
    if (!post_probe.ok()) {
      s.invalidated=true;b.close(b.ctx,s);s.open=false;
      return Err(rid,post_probe.code,StatusErr(post_probe),true);
    }
    if (before.foreground!=after.foreground || before.focus_identity!=after.focus_identity ||
        before.cursor_x!=after.cursor_x || before.cursor_y!=after.cursor_y) {
      s.invalidated=true;b.close(b.ctx,s);s.open=false;
      return Err(rid,"E_FOCUS_CHANGED","foreground, focus or cursor changed during completion; session invalidated",true);
    }
    if(std::chrono::steady_clock::now()>=settled)break;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  if (!act_status.ok()) {
    if (act_status.may_have_executed) {
      s.invalidated = true;
      b.close(b.ctx, s);
      s.open = false;
    }
    return Err(rid, act_status.code, StatusErr(act_status), act_status.may_have_executed);
  }
  return Ok(rid, {{"applied", true},
                  {"action", a.action},
                  {"revision", s.revision},
                  {"detail", json(detail)}});
}
}  // namespace

std::string HandleRequest(const std::string& line, Session& s, const Backend& b, const ControlsTable& c,
                          bool& shutdown) {
  json doc;
  try {
    doc = json::parse(line);
  } catch (const std::exception&) {
    return Err("", "E_BAD_REQUEST", "invalid JSON");
  }
  if (!doc.is_object()) return Err("", "E_BAD_REQUEST", "request must be a JSON object");
  static const std::vector<std::string> allowed_fields = {
      "op", "request_id", "target_id", "mode", "session_id", "element_id", "expected_revision", "action", "value", "checked", "direction"};
  for (auto it = doc.begin(); it != doc.end(); ++it) {
    if (std::find(allowed_fields.begin(), allowed_fields.end(), it.key()) == allowed_fields.end())
      return Err("", "E_BAD_REQUEST", "request contains an unsupported field");
  }
  json rid = doc.contains("request_id") ? doc.at("request_id") : json();
  if (!rid.is_string() || rid.get<std::string>().empty() || rid.get<std::string>().size() > 128)
    return Err("", "E_BAD_REQUEST", "request_id must be a non-empty string up to 128 characters");
  std::string op, err;
  if (!GetString(doc, "op", op, err)) return Err(rid, "E_BAD_REQUEST", err);
  if (!InList(kOps, kOpsCount, op)) return Err(rid, "E_BAD_REQUEST", "unsupported op");

  if (op == "application") return Err(rid, "E_UNSUPPORTED_ACTION", "application lifecycle requires protocol v2");
  if (op == "gesture" || op == "prepare_input" || op == "commit_input") return Err(rid,"E_UNSUPPORTED_ACTION","interactive input requires protocol v2");
  if (op == "capture") return Err(rid, "E_UNSUPPORTED_ACTION", "visual capture requires protocol v2");

  if (op == "discover") {
    bool available = false;
    std::string app_id;
    Status st = b.discover(b.ctx, available, app_id);
    if (!st.ok()) return Err(rid, st.code, StatusErr(st));
    return Ok(rid, {{"target_id", s.target_id},
                    {"application_id", app_id},
                    {"available", available},
                    {"mutations_enabled", true},
                    {"autofocusing_disabled", true}});
  }

  if (op == "open") {
    std::string mode, target;
    if (!GetString(doc, "mode", mode, err)) return Err(rid, "E_BAD_REQUEST", err);
    if (!GetString(doc, "target_id", target, err)) return Err(rid, "E_BAD_REQUEST", err);
    if (mode != "background_semantic") {
      if (mode == "strict_isolated")
        return Err(rid, "E_INTERFERENCE_RISK", "strict_isolated is not served by the native UIA helper");
      return Err(rid, "E_BAD_REQUEST", "mode must be background_semantic");
    }
    if (target != s.target_id) return Err(rid, "E_TARGET_MISMATCH", "unknown target_id");
    if (s.open) return Err(rid, "E_ALREADY_OPEN", "session already open");
    Status st = b.bind(b.ctx, s);
    if (!st.ok()) return Err(rid, st.code, StatusErr(st));
    s.open = true;
    s.invalidated = false;
    const std::string random = NewOpaqueHandle();
    if (random.empty()) return Err(rid, "E_INTERNAL", "could not allocate opaque session handle");
    s.session_id = "s-" + random;
    return Ok(rid, {{"session_id", s.session_id}});
  }

  if (!s.open) return Err(rid, "E_NO_SESSION", "open a session first");
  if (s.invalidated) return Err(rid, "E_SESSION_INVALID", "session invalidated by a focus change");
  std::string target;
  if (!GetString(doc, "target_id", target, err)) return Err(rid, "E_BAD_REQUEST", err);
  if (target != s.target_id) return Err(rid, "E_TARGET_MISMATCH", "unknown target_id");
  std::string sid;
  if (!GetString(doc, "session_id", sid, err)) return Err(rid, "E_BAD_REQUEST", err);
  if (sid != s.session_id) return Err(rid, "E_TARGET_MISMATCH", "unknown session_id");
  Status rv = b.revalidate(b.ctx, s);
  if (!rv.ok()) return Err(rid, rv.code, StatusErr(rv));

  if (op == "snapshot") {
    SnapshotResult snap;
    Status st = b.snapshot(b.ctx, s, snap);
    if (!st.ok()) return Err(rid, st.code, StatusErr(st));
    ApplySnapshot(s, snap);
    json els = json::array();
    for (const ElemInfo& e : s.elements) els.push_back(ElementJson(e));
    json result = {{"elements", els}, {"revision", s.revision}, {"truncated", snap.truncated}};
    std::string response = Ok(rid, result);
    while (response.size() > static_cast<size_t>(kMaxLineBytes) && !els.empty()) {
      els.erase(els.end() - 1);
      result["truncated"] = true;
      result["elements"] = els;
      response = Ok(rid, result);
    }
    return response;
  }

  if (op == "close") {
    b.close(b.ctx, s);
    s.open = false;
    shutdown = true;
    return Ok(rid, {{"closed", true}});
  }
  return DoAct(rid, doc, s, b, c);
}


// --- V2 target registry and broker (multi-window, exact identities) ---

Status TargetRegistry::Synchronize(const std::vector<TargetObservation>& observations,
                                   std::vector<TargetEntry>& out_entries) {
  out_entries.clear();
  if (observations.size() > kMaxTargets)
    return Status::Fail("E_TARGET_LIMIT", "more than 32 candidate windows; refusing to guess");
  for (const TargetObservation& o : observations) {
    if (o.window_key == 0 || o.process_start == 0 || o.root_token.empty())
      return Status::Fail("E_TARGET_IDENTITY", "window observation lacks an exact identity");
  }
  for (size_t i = 0; i < observations.size(); ++i)
    for (size_t j = i + 1; j < observations.size(); ++j)
      if (observations[i].window_key == observations[j].window_key &&
          observations[i].process_start == observations[j].process_start)
        return Status::Fail("E_TARGET_IDENTITY", "duplicate window identity in one enumeration");

  std::vector<TargetEntry> next;
  for (const TargetObservation& o : observations) {
    TargetEntry e;
    bool fresh = true;
    for (const TargetEntry& live : live_) {
      if (live.window_key != o.window_key || live.process_start != o.process_start) continue;
      if (live.root_token == o.root_token) {
        e = live;  // same window, same root element: keep the stable id
        fresh = false;
      }
      // A root_token mismatch drops the old id here; it never returns because
      // fresh ids are random and this entry is replaced below.
      break;
    }
    if (fresh) {
      const std::string h = NewOpaqueHandle();
      if (h.empty()) return Status::Fail("E_INTERNAL", "could not allocate an opaque target id");
      e.target_id = "t-" + h;
    }
    e.window_key = o.window_key;
    e.process_start = o.process_start;
    e.root_token = o.root_token;
    e.label = o.label;
    e.x = o.x; e.y = o.y; e.width = o.width; e.height = o.height;
    e.display_ids = o.display_ids;
    e.minimized = o.minimized;
    next.push_back(std::move(e));
  }
  // Live entries that were not observed closed their windows: they leave the
  // registry here and their ids are never handed out again.
  live_ = std::move(next);
  out_entries = live_;
  return Status::Ok();
}

const TargetEntry* TargetRegistry::Find(const std::string& target_id) const {
  if (target_id.empty()) return nullptr;
  for (const TargetEntry& e : live_)
    if (e.target_id == target_id) return &e;
  return nullptr;
}

void Broker::CloseAll(const Backend& b) {
  for (auto& entry : sessions) {
    Session& s = *entry.second;
    if (s.open) b.close(b.ctx, s);
    s.open = false;
  }
  sessions.clear();
}

std::string HandleRequest(const std::string& line, Broker& broker, const Backend& b,
                          const ControlsTable& c, bool& shutdown) {
  json doc;
  try {
    doc = json::parse(line);
  } catch (const std::exception&) {
    return Err("", "E_BAD_REQUEST", "invalid JSON");
  }
  if (!doc.is_object()) return Err("", "E_BAD_REQUEST", "request must be a JSON object");
  static const std::vector<std::string> allowed_fields = {
      "op", "request_id", "target_id", "mode", "session_id", "element_id", "expected_revision",
      "action", "value", "checked", "direction", "input_token", "surface_id", "kind", "points", "swipe_backend", "point", "expected_target", "confirmation_id"};
  for (auto it = doc.begin(); it != doc.end(); ++it) {
    if (std::find(allowed_fields.begin(), allowed_fields.end(), it.key()) == allowed_fields.end())
      return Err("", "E_BAD_REQUEST", "request contains an unsupported field");
  }
  json rid = doc.contains("request_id") ? doc.at("request_id") : json();
  if (!rid.is_string() || rid.get<std::string>().empty() || rid.get<std::string>().size() > 128)
    return Err("", "E_BAD_REQUEST", "request_id must be a non-empty string up to 128 characters");
  std::string op, err;
  if (!GetString(doc, "op", op, err)) return Err(rid, "E_BAD_REQUEST", err);
  if (!InList(kOps, kOpsCount, op)) return Err(rid, "E_BAD_REQUEST", "unsupported op");

  // Session-less lifecycle of the configured executable. Exactly op, request_id
  // and action are accepted: no target, session, PID, path or command field ever
  // reaches the backend, and nothing dispatches unless the trusted launch-time
  // opt-in supplied the application callback.
  if (op == "application") {
    if (doc.size() != 3)
      return Err(rid, "E_BAD_REQUEST", "application accepts only op, request_id and action");
    std::string action;
    if (!GetString(doc, "action", action, err)) return Err(rid, "E_BAD_REQUEST", err);
    if (!InList(kApplicationActions, kApplicationActionCount, action))
      return Err(rid, "E_BAD_REQUEST", "action must be status, launch or quit");
    if (!b.application)
      return Err(rid, "E_POLICY_DENIED", "application lifecycle was not enabled at launch");
    ApplicationResult result;
    Status st = b.application(b.ctx, action, result);
    if (!st.ok()) return Err(rid, st.code, StatusErr(st), st.may_have_executed);
    if (action == "quit" && result.changed && !result.running) {
      // The owned application exited, so no session or target id may outlive it:
      // release every session and retire the registry. Later discovery re-populates.
      broker.CloseAll(b);
      const std::vector<TargetObservation> none;
      std::vector<TargetEntry> retired;
      Status cleared = broker.registry.Synchronize(none, retired);
      if (!cleared.ok()) return Err(rid, cleared.code, StatusErr(cleared));
    }
    return Ok(rid, json{{"running", result.running},
                        {"managed", result.managed},
                        {"changed", result.changed}});
  }

  if (op == "discover") {
    if (!b.enumerate_targets) return Err(rid, "E_INTERNAL", "backend cannot enumerate targets");
    std::vector<TargetObservation> obs;
    std::string app_id;
    Status st = b.enumerate_targets(b.ctx, obs, app_id);
    if (!st.ok()) return Err(rid, st.code, StatusErr(st));
    std::vector<TargetEntry> entries;
    Status sy = broker.registry.Synchronize(obs, entries);
    if (!sy.ok()) return Err(rid, sy.code, StatusErr(sy));
    broker.app_id = app_id;
    json targets = json::array();
    for (const TargetEntry& e : entries) {
      json displays = json::array();
      for (const std::string& d : e.display_ids) displays.push_back(d);
      targets.push_back({{"target_id", e.target_id},
                         {"application_id", app_id},
                         {"label", IsSensitiveText(e.label) ? Redact(e.label) : e.label},
                         {"interactive_input", b.input_operation != nullptr},{"gesture_backends",b.gesture_backends},
                         {"window", {{"bounds", {{"x", e.x},
                                                 {"y", e.y},
                                                 {"width", e.width},
                                                 {"height", e.height},
                                                 {"coordinate_space", "desktop_physical_pixels"}}},
                                    {"display_ids", displays},
                                    {"minimized", e.minimized}}}});
    }
    return Ok(rid, {{"protocol_version", 2},
                    {"targets", targets},
                    {"mutations_enabled", true},
                    {"autofocusing_disabled", true},
                    {"visual_capture", b.capture != nullptr},{"interactive_input",b.input_operation != nullptr},{"gesture_backends",b.gesture_backends}});
  }

  if (op == "open") {
    std::string mode, target;
    if (!GetString(doc, "mode", mode, err)) return Err(rid, "E_BAD_REQUEST", err);
    if (!GetString(doc, "target_id", target, err)) return Err(rid, "E_BAD_REQUEST", err);
    if (mode == "interactive_desktop" && !b.input_operation) return Err(rid,"E_POLICY_DENIED","interactive desktop input was not enabled at launch");
    if (mode != "background_semantic" && mode != "interactive_desktop") {
      if (mode == "strict_isolated")
        return Err(rid, "E_INTERFERENCE_RISK", "strict_isolated is not served by the native UIA helper");
      return Err(rid, "E_BAD_REQUEST", "mode must be background_semantic");
    }
    const TargetEntry* entry = broker.registry.Find(target);
    if (!entry)
      return Err(rid, "E_TARGET_NOT_FOUND", "target_id is not a live target of this helper");
    if (entry->minimized)
      return Err(rid, "E_TARGET_NOT_FOUND", "minimized windows cannot be observed or mutated");
    if (broker.sessions.size() >= kMaxSessions)
      return Err(rid, "E_SESSION_LIMIT", "32 simultaneous sessions is the bound");
    auto s = std::make_unique<Session>();
    s->target_id = entry->target_id;
    s->mode = mode;
    s->hwnd = entry->window_key;
    s->start_time = entry->process_start;
    s->binding_token = entry->root_token;
    s->app_id = broker.app_id;
    Status st = b.bind(b.ctx, *s);
    if (!st.ok()) return Err(rid, st.code, StatusErr(st));  // bind owns no state on failure
    const std::string random = NewOpaqueHandle();
    if (random.empty()) {
      b.close(b.ctx, *s);  // release whatever bind retained before the id failed
      return Err(rid, "E_INTERNAL", "could not allocate an opaque session handle");
    }
    s->session_id = "s-" + random;
    s->open = true;
    s->invalidated = false;
    const std::string sid = s->session_id;
    broker.sessions.emplace(sid, std::move(s));
    return Ok(rid, {{"session_id", sid}, {"target_id", entry->target_id}});
  }

  std::string sid, target;
  if (!GetString(doc, "session_id", sid, err)) return Err(rid, "E_BAD_REQUEST", err);
  if (!GetString(doc, "target_id", target, err)) return Err(rid, "E_BAD_REQUEST", err);
  auto it = broker.sessions.find(sid);
  if (it == broker.sessions.end() || it->second->target_id != target)
    return Err(rid, "E_TARGET_MISMATCH", "unknown session_id or target_id");
  Session& s = *it->second;
  if (op == "close") {
    // An exact session+target close always releases and succeeds, even after
    // the target retired or the session invalidated; otherwise it could never
    // be closed and its backend state would leak.
    b.close(b.ctx, s);
    s.open = false;
    broker.sessions.erase(it);  // one session down; the helper keeps serving the rest
    return Ok(rid, {{"closed", true}});
  }
  if (s.invalidated) return Err(rid, "E_SESSION_INVALID", "session invalidated by a focus change");
  if (!broker.registry.Find(s.target_id)) {
    b.close(b.ctx, s);
    s.open = false;
    broker.sessions.erase(it);
    return Err(rid, "E_TARGET_NOT_FOUND", "target closed; the session was released");
  }
  Status rv = b.revalidate(b.ctx, s);
  if (!rv.ok()) return Err(rid, rv.code, StatusErr(rv));

  if (op == "snapshot") {
    SnapshotResult snap;
    Status st = b.snapshot(b.ctx, s, snap);
    if (!st.ok()) return Err(rid, st.code, StatusErr(st));
    ApplySnapshot(s, snap);
    json els = json::array();
    for (const ElemInfo& e : s.elements) els.push_back(ElementJson(e));
    json result = {{"elements", els}, {"revision", s.revision}, {"truncated", snap.truncated}};
    std::string response = Ok(rid, result);
    while (response.size() > static_cast<size_t>(kMaxLineBytes) && !els.empty()) {
      els.erase(els.end() - 1);
      result["truncated"] = true;
      result["elements"] = els;
      response = Ok(rid, result);
    }
    return response;
  }

  if (op == "capture") {
    if (doc.size() != 4) return Err(rid, "E_BAD_REQUEST", "capture accepts only exact target and session handles");
    if (!b.capture) return Err(rid, "E_POLICY_DENIED", "visual disclosure was not enabled at launch");
    json result;
    Status st = b.capture(b.ctx, s, result);
    if (!st.ok()) return Err(rid, st.code, StatusErr(st));
    Status after = b.revalidate(b.ctx, s);
    if (!after.ok()) return Err(rid, after.code, StatusErr(after));
    std::string response = Ok(rid, result);
    if (response.size() > static_cast<size_t>(kMaxResponseBytes))
      return Err(rid, "E_RESOURCE_LIMIT", "visual response exceeds bounded transport");
    return response;
  }

  if (op == "gesture" || op == "prepare_input" || op == "commit_input") {
    if(s.mode!="interactive_desktop"||!b.input_operation)return Err(rid,"E_POLICY_DENIED","physical input requires an explicitly enabled interactive session");
    json result;Status st=b.input_operation(b.ctx,s,doc,c,result);
    if(!st.ok())return Err(rid,st.code,StatusErr(st),st.may_have_executed);
    return Ok(rid,result);
  }

  if(s.mode=="interactive_desktop")return Err(rid,"E_POLICY_DENIED","interactive mutations require prepare_input and commit_input");
  std::string out = DoAct(rid, doc, s, b, c);
  if (!s.open) broker.sessions.erase(it);  // act invalidated the session
  (void)shutdown;                          // V2 never shuts down on one op
  return out;
}

}  // namespace adl
