#include "protocol.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <sstream>
#include <string>
#include <vector>
namespace {
using namespace adl;
std::string g_test; int g_failures=0;
void Fail(int line,const std::string& message,const std::string& detail="") {
  ++g_failures;std::fprintf(stderr,"FAIL %s:%d %s %s\n",g_test.c_str(),line,message.c_str(),detail.c_str());
}
#define CHECK(x) do{if(!(x))Fail(__LINE__,#x);}while(false)
#define CHECK_EQ(a,b) do{if((a)!=(b)){std::ostringstream o;o<<(a)<<" != "<<(b);Fail(__LINE__,#a,o.str());}}while(false)
#define CHECK_CONTAINS(s,v) CHECK((s).find(v)!=std::string::npos)
#define CHECK_NOT_CONTAINS(s,v) CHECK((s).find(v)==std::string::npos)
struct Fake {
 std::vector<std::vector<ElemInfo>> snapshots;
 std::vector<FocusProbe> probes;
 std::vector<Status> act,probe;
 std::vector<TargetObservation> obs; Status enumerate; int n_enumerate=0;
 std::vector<ActionRequest> acts;
 std::vector<std::string> app_actions;       // lifecycle actions actually dispatched
 std::vector<Status> app_status;             // per-call lifecycle callback outcome
 std::vector<ApplicationResult> app_result;  // per-call lifecycle callback result
 int n_bind=0,n_revalidate=0,n_snapshot=0,n_act=0,n_probe=0,n_close=0,n_application=0;
 void Reset(){n_bind=n_revalidate=n_snapshot=n_act=n_probe=n_close=n_application=0;acts.clear();
   app_actions.clear();app_status.clear();app_result.clear();}
};
Backend MakeBackend(Fake& f) {
 Backend b{};b.ctx=&f;
 b.discover=[](void*,bool& available,std::string& id){available=true;id="fixture";return Status::Ok();};
 b.bind=[](void* p,Session&){++static_cast<Fake*>(p)->n_bind;return Status::Ok();};
 b.revalidate=[](void* p,Session&){++static_cast<Fake*>(p)->n_revalidate;return Status::Ok();};
 b.snapshot=[](void* p,Session&,SnapshotResult& out){auto& f=*static_cast<Fake*>(p);int i=f.n_snapshot++;if(!f.snapshots.empty())out.elements=f.snapshots[std::min<size_t>(i,f.snapshots.size()-1)];return Status::Ok();};
 b.act=[](void* p,Session&,const ActionRequest& a,std::string& detail){auto& f=*static_cast<Fake*>(p);int i=f.n_act++;f.acts.push_back(a);detail="done";return f.act.empty()?Status::Ok():f.act[std::min<size_t>(i,f.act.size()-1)];};
 b.probe=[](void* p,Session&,FocusProbe& out){auto& f=*static_cast<Fake*>(p);int i=f.n_probe++;out.foreground=100;out.focus_identity="human";if(!f.probes.empty())out=f.probes[std::min<size_t>(i,f.probes.size()-1)];return f.probe.empty()?Status::Ok():f.probe[std::min<size_t>(i,f.probe.size()-1)];};
 b.close=[](void* p,Session&){++static_cast<Fake*>(p)->n_close;};
 b.enumerate_targets=[](void* p,std::vector<TargetObservation>& out,std::string& app){auto& f=*static_cast<Fake*>(p);++f.n_enumerate;out=f.obs;app="fixture";return f.enumerate;};
 return b;
}
// Opt-in lifecycle callback: only present when the launch flag enabled it.
void EnableLifecycle(Fake&, Backend& b) {
  b.application = [](void* ctx, const std::string& action, ApplicationResult& out) -> Status {
    Fake& f = *static_cast<Fake*>(ctx);
    ++f.n_application;
    f.app_actions.push_back(action);
    const size_t i = f.app_actions.size() - 1;
    if (!f.app_result.empty()) out = f.app_result[std::min<size_t>(i, f.app_result.size() - 1)];
    return f.app_status.empty() ? Status::Ok() : f.app_status[std::min<size_t>(i, f.app_status.size() - 1)];
  };
}
const char* const kTarget = "tgt-1";

ElemInfo MakeElem(const std::string& automation_id, const std::string& role,
                  const std::string& name = "Find", const std::string& value = "") {
  ElemInfo e;
  e.identity = "idn-" + automation_id;
  e.automation_id = automation_id;
  e.role = role;
  e.name = name;
  e.value = value;
  e.enabled = true;
  return e;
}

ControlsTable MakeControls() {
  json doc = {
      {"FindButton", {{"role", "button"}, {"allowed", {"click"}}}},
      {"NameEdit", {{"role", "edit"}, {"allowed", {"fill"}}}},
      {"ListPane", {{"role", "pane"}, {"allowed", {"scroll"}}}},
      {"AgreeBox", {{"role", "checkbox"}, {"allowed", {"check"}}}},
      {"ApiKeyInput", {{"role", "edit"}, {"allowed", {"fill"}}}},
  };
  ControlsTable t;
  std::string err;
  if (!adl::LoadControls(doc, t, err)) {
    std::fprintf(stderr, "FATAL: fixture controls table rejected: %s\n", err.c_str());
    std::exit(2);
  }
  return t;
}

json Parse(const std::string& s) {
  try { return json::parse(s); } catch (const std::exception&) { Fail(__LINE__, "response not JSON", s.substr(0, 200)); }
  return json();
}
std::string Code(const std::string& r) {
  json j = Parse(r);
  if (j.value("ok", false)) return "OK";
  return j.contains("error") && j.at("error").contains("code") ? j.at("error").at("code").get<std::string>() : "<none>";
}
bool MayExec(const std::string& r) {
  json j = Parse(r);
  return !j.value("ok", false) && j.at("error").value("may_have_executed", false);
}
long long Rev(const std::string& r) {
  json j = Parse(r);
  return j.contains("result") && j.at("result").contains("revision") ? j.at("result").at("revision").get<long long>() : -1;
}
std::string Sid(const std::string& r) {
  json j = Parse(r);
  return j.contains("result") && j.at("result").contains("session_id") ? j.at("result").at("session_id").get<std::string>() : "";
}
std::string OpenReq() {
  return json{{"op", "open"}, {"request_id", "ro"}, {"mode", "background_semantic"}, {"target_id", kTarget}}.dump();
}
std::string SnapReq(const std::string& sid) {
  return json{{"op", "snapshot"}, {"request_id", "rs"}, {"target_id", kTarget}, {"session_id", sid}}.dump();
}
std::string ActReq(const std::string& sid, const std::string& eid, long long rev, const json& extra) {
  json j{{"op", "act"}, {"request_id", "ra"}, {"target_id", kTarget}, {"session_id", sid},
         {"element_id", eid}, {"expected_revision", rev}};
  j.update(extra);
  return j.dump();
}

// Open a session and take the first snapshot so element ids exist.
std::string OpenAndSnap(Fake& f, Session& s, const Backend& b, const ControlsTable& c,
                        std::vector<ElemInfo> tree) {
  f.snapshots = {tree};
  bool sd = false;
  std::string sid = Sid(adl::HandleRequest(OpenReq(), s, b, c, sd));
  if (sid.empty()) return "";
  adl::HandleRequest(SnapReq(sid), s, b, c, sd);
  return sid;
}

void T_strict_isolated() {
  g_test = "strict_isolated_denied_before_bind";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  bool sd = false;
  std::string r = adl::HandleRequest(
      json{{"op", "open"}, {"request_id", "r"}, {"mode", "strict_isolated"}, {"target_id", kTarget}}.dump(), s, b, c, sd);
  CHECK_EQ(Code(r), "E_INTERFERENCE_RISK");
  CHECK_EQ(std::to_string(f.n_bind), "0");
  CHECK(!s.open);
}

void T_target_session_mismatch() {
  g_test = "wrong_target_or_session_no_side_effects";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  bool sd = false;
  std::string r = adl::HandleRequest(
      json{{"op", "open"}, {"request_id", "r"}, {"mode", "background_semantic"}, {"target_id", "other"}}.dump(), s, b, c, sd);
  CHECK_EQ(Code(r), "E_TARGET_MISMATCH");
  CHECK_EQ(std::to_string(f.n_bind), "0");
  std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("FindButton", "button")});
  CHECK(!sid.empty());
  f.Reset();
  CHECK_EQ(Code(adl::HandleRequest(json{{"op", "snapshot"}, {"request_id", "r"}, {"target_id", "other"}, {"session_id", sid}}.dump(), s, b, c, sd)), "E_TARGET_MISMATCH");
  CHECK_EQ(Code(adl::HandleRequest(json{{"op", "snapshot"}, {"request_id", "r"}, {"target_id", kTarget}, {"session_id", "s-nope"}}.dump(), s, b, c, sd)), "E_TARGET_MISMATCH");
  CHECK_EQ(Code(adl::HandleRequest(ActReq("s-nope", "e-x", 1, json({{"action", "click"}})), s, b, c, sd)), "E_TARGET_MISMATCH");
  CHECK_EQ(std::to_string(f.n_revalidate + f.n_snapshot + f.n_act + f.n_close), "0");
}

void T_argument_validation() {
  g_test = "fill_check_direction_nul_rejected_before_backend";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  bool sd = false;
  std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("NameEdit", "edit"), MakeElem("FindButton", "button")});
  const std::string eid = s.elements.front().id;
  const long long rev = s.revision;
  f.Reset();
  struct Case { const char* n; json extra; };
  const Case cs[] = {
      {"fill_no_value", {{"action", "fill"}}},
      {"fill_nul", {{"action", "fill"}, {"value", std::string("a\0b", 3)}}},
      {"fill_too_long", {{"action", "fill"}, {"value", std::string(4097, 'x')}}},
      {"check_no_checked", {{"action", "check"}}},
      {"scroll_no_dir", {{"action", "scroll"}}},
      {"scroll_bad_dir", {{"action", "scroll"}, {"direction", "sideways"}}},
      {"bad_action", {{"action", "explode"}}},
      {"value_on_click", {{"action", "click"}, {"value", "x"}}},
      {"checked_on_click", {{"action", "click"}, {"checked", true}}},
      {"dir_on_click", {{"action", "click"}, {"direction", "up"}}},
  };
  for (const Case& k : cs) {
    std::string r = adl::HandleRequest(ActReq(sid, eid, rev, k.extra), s, b, c, sd);
    if (Code(r) != "E_BAD_REQUEST") Fail(__LINE__, std::string(k.n) + " got ", Code(r));
    CHECK_NOT_CONTAINS(r, "may_have_executed");
  }
  CHECK_EQ(std::to_string(f.n_act + f.n_probe), "0");
}

void T_policy_denials() {
  struct Case { const char* n; const char* aid; const char* role; const char* name; const char* action;
                bool sens, pwd, en; json extra; const char* want; };
  const Case cs[] = {
      {"unlisted_control", "MysteryButton", "button", "Find", "click", false, false, true, {}, "E_NOT_ALLOWED"},
      {"unlisted_action", "FindButton", "button", "Find", "fill", false, false, true, {{"value", "x"}}, "E_NOT_ALLOWED"},
      {"wrong_role", "FindButton", "edit", "Find", "click", false, false, true, {}, "E_CONTROL_TYPE_MISMATCH"},
      {"sensitive", "ApiKeyInput", "edit", "API Key", "fill", true, false, true, {{"value", "x"}}, "E_CONTROL_BLOCKED"},
      {"blocked_name", "FindButton", "button", "Submit Form", "click", false, false, true, {}, "E_CONTROL_BLOCKED"},
      {"password", "NameEdit", "edit", "Name", "fill", false, true, true, {{"value", "x"}}, "E_CONTROL_BLOCKED"},
      {"disabled", "FindButton", "button", "Find", "click", false, false, false, {}, "E_NOT_ENABLED"},
  };
  for (const Case& k : cs) {
    g_test = std::string("policy_denials_before_act/") + k.n;
    Fake f; Session s; s.target_id = kTarget;
    Backend b = MakeBackend(f); ControlsTable c = MakeControls();
    bool sd = false;
    ElemInfo e = MakeElem(k.aid, k.role, k.name);
    e.sensitive = k.sens; e.is_password = k.pwd; e.enabled = k.en;
    std::string sid = OpenAndSnap(f, s, b, c, {e});
    const std::string eid = s.elements.front().id;
    f.Reset();
    json extra={{"action",k.action}}; if (!k.extra.is_null()) extra.update(k.extra);
    std::string r = adl::HandleRequest(ActReq(sid, eid, s.revision, extra), s, b, c, sd);
    if (Code(r) != k.want) Fail(__LINE__, std::string(k.n) + " got ", Code(r));
    CHECK_EQ(std::to_string(f.n_act + f.n_probe + f.n_close), "0");
    CHECK(s.open);
  }
}

void T_secrets_suppressed() {
  g_test = "snapshot_suppresses_secret_name_and_value";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  ElemInfo api = MakeElem("ApiKeyInput", "edit", "API Key", "sk-live-SECRETVALUE");
  ElemInfo pw = MakeElem("PasswordBox", "edit", "Password", "hunter2-SECRETVALUE");
  pw.is_password = true;
  std::string sid = OpenAndSnap(f, s, b, c, {api, pw, MakeElem("FindButton", "button")});
  bool sd = false;
  std::string r = adl::HandleRequest(SnapReq(sid), s, b, c, sd);
  CHECK_EQ(Code(r), "OK");
  CHECK_NOT_CONTAINS(r, "SECRETVALUE");
  CHECK_NOT_CONTAINS(r, "hunter2");
  CHECK_NOT_CONTAINS(r, "sk-live");
  CHECK_NOT_CONTAINS(r, "ApiKeyInput");
  CHECK_NOT_CONTAINS(r, "idn-");
  CHECK_CONTAINS(r, "[redacted]");
  json j = Parse(r);
  const json& els = j.at("result").at("elements");
  CHECK_EQ(std::to_string(els.size()), "3");
  CHECK_EQ(els.at(0).at("name").get<std::string>(), std::string("[redacted]"));
  CHECK_EQ(els.at(0).at("value").get<std::string>(), std::string());
  CHECK_EQ(els.at(0).value("sensitive", false), true);
  CHECK_EQ(els.at(1).at("value").get<std::string>(), std::string());
}

void T_revision_stability() {
  g_test = "revision_stable_until_tree_changes";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("FindButton", "button")});
  bool sd = false;
  long long r1 = Rev(adl::HandleRequest(SnapReq(sid), s, b, c, sd));
  long long r2 = Rev(adl::HandleRequest(SnapReq(sid), s, b, c, sd));
  CHECK_EQ(std::to_string(r1), "1");
  CHECK_EQ(std::to_string(r2), "1");
  f.snapshots = {{MakeElem("FindButton", "button", "Renamed")}};
  CHECK_EQ(std::to_string(Rev(adl::HandleRequest(SnapReq(sid), s, b, c, sd))), "2");
}

void T_stale_before_dispatch() {
  g_test = "external_change_before_act_rejects_stale_before_dispatch";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("FindButton", "button")});
  bool sd = false;
  const std::string eid = s.elements.front().id;
  const long long rev = s.revision;
  f.snapshots = {{MakeElem("FindButton", "button", "Renamed")}};  // UI changed externally
  f.Reset();
  std::string r = adl::HandleRequest(ActReq(sid, eid, rev, json({{"action", "click"}})), s, b, c, sd);
  CHECK_EQ(Code(r), "E_STALE_REVISION");
  CHECK_EQ(std::to_string(f.n_act + f.n_probe + f.n_close), "0");
  CHECK(s.open);
}

void T_separator_collision() {
  g_test = "separator_names_cannot_collide_signature";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  bool sd = false;
  const std::string sep = std::string("a],\"b\") , \"c");
  ElemInfo p = MakeElem("FindButton", "button", sep, "v1");
  ElemInfo q = MakeElem("FindButton", "button", "x", std::string("y\"],\n[\"z"));
  q.identity = "idn-q";
  f.snapshots = {{p, q}};
  std::string sid = Sid(adl::HandleRequest(OpenReq(), s, b, c, sd));
  long long r1 = Rev(adl::HandleRequest(SnapReq(sid), s, b, c, sd));
  f.snapshots = {{q, p}};  // swapped: same multiset of fields, different tree
  long long r2 = Rev(adl::HandleRequest(SnapReq(sid), s, b, c, sd));
  CHECK(r2 > r1);
  f.snapshots = {{MakeElem("FindButton", "button", sep)}};  // one element, separator text
  long long r3 = Rev(adl::HandleRequest(SnapReq(sid), s, b, c, sd));
  CHECK(r3 > r2);
  f.snapshots = {{MakeElem("FindButton", "button", "a],\n[b"), MakeElem("FindButton", "button", "c")}};
  long long r4 = Rev(adl::HandleRequest(SnapReq(sid), s, b, c, sd));
  CHECK(r4 > r3);
  long long r5 = Rev(adl::HandleRequest(SnapReq(sid), s, b, c, sd));  // unchanged again
  CHECK_EQ(std::to_string(r5), std::to_string(r4));
}

void T_success_delegates_once() {
  g_test = "successful_fill_and_click_delegate_exactly_once";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  bool sd = false;
  std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("NameEdit", "edit", "Name"), MakeElem("FindButton", "button")});
  const std::string edit = s.elements[0].id, btn = s.elements[1].id;
  const long long rev = s.revision;
  f.Reset();
  std::string r = adl::HandleRequest(ActReq(sid, edit, rev, json({{"action", "fill"}, {"value", "hello"}})), s, b, c, sd);
  CHECK_EQ(Code(r), "OK");
  CHECK_EQ(std::to_string(f.n_act), "1");
  CHECK(f.n_probe>=2);
  CHECK_EQ(f.acts[0].action, "fill");
  CHECK_EQ(f.acts[0].value, "hello");
  CHECK_EQ(f.acts[0].identity, "idn-NameEdit");
  CHECK_EQ(f.acts[0].automation_id, "NameEdit");
  CHECK_EQ(f.acts[0].expected_role, "edit");
  CHECK_EQ(f.acts[0].element_id, edit);
  CHECK_CONTAINS(r, "\"applied\":true");
  CHECK_CONTAINS(r, "done");
  r = adl::HandleRequest(ActReq(sid, btn, rev, json({{"action", "click"}})), s, b, c, sd);
  CHECK_EQ(Code(r), "OK");
  CHECK_EQ(std::to_string(f.n_act), "2");
  CHECK_EQ(f.acts[1].action, "click");
  CHECK(s.open);
  CHECK(!s.invalidated);
}

void T_delayed_focus_change_invalidates() {
  g_test="delayed_post_probe_change_invalidates_with_uncertainty";
  Fake f;Backend b=MakeBackend(f);ControlsTable c=MakeControls();Session s;s.target_id=kTarget;bool shutdown=false;
  f.snapshots={{MakeElem("NameEdit","edit","Reference")}};
  FocusProbe a;a.foreground=100;a.focus_identity="human";FocusProbe changed=a;changed.cursor_x=3;
  f.probes={a,a,changed};
  auto opened=HandleRequest(OpenReq(),s,b,c,shutdown);
  auto snapshot=HandleRequest(SnapReq(s.session_id),s,b,c,shutdown);
  auto parsed=Parse(snapshot);auto element=parsed.at("result").at("elements").at(0).at("id").get<std::string>();
  auto request=json{{"op","act"},{"request_id","delayed"},{"target_id",s.target_id},{"session_id",s.session_id},{"element_id",element},{"action","fill"},{"value","TEST"},{"expected_revision",parsed.at("result").at("revision")}};
  auto result=HandleRequest(request.dump(),s,b,c,shutdown);
  CHECK_EQ(Code(result),"E_FOCUS_CHANGED");CHECK(Parse(result).at("error").value("may_have_executed",false));CHECK_EQ(f.n_act,1);CHECK(s.invalidated);CHECK(f.n_probe>=3);
}

void T_focus_change_invalidates() {
  g_test = "post_probe_change_invalidates_with_uncertainty";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  bool sd = false;
  std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("FindButton", "button")});
  const std::string eid = s.elements.front().id;
  FocusProbe a; a.foreground = 100; a.focus_identity = "idn-FindButton"; a.cursor_x = 5; a.cursor_y = 5;
  FocusProbe b2 = a; b2.cursor_x = 999;  // cursor moved during the action
  f.probes = {a, b2};
  f.Reset();
  std::string r = adl::HandleRequest(ActReq(sid, eid, s.revision, json({{"action", "click"}})), s, b, c, sd);
  CHECK_EQ(Code(r), "E_FOCUS_CHANGED");
  CHECK(MayExec(r));
  CHECK(s.invalidated);
  CHECK(!s.open);
  CHECK_EQ(std::to_string(f.n_close), "1");
  CHECK_EQ(Code(adl::HandleRequest(SnapReq(sid), s, b, c, sd)), "E_NO_SESSION");
}

void T_failed_action_uncertainty() {
  g_test = "failed_action_may_have_executed_invalidates";
  {  // may_have_executed=true: invalidate + close + uncertainty flag
    Fake f; Session s; s.target_id = kTarget;
    Backend b = MakeBackend(f); ControlsTable c = MakeControls();
    bool sd = false;
    std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("FindButton", "button")});
    const std::string eid = s.elements.front().id;
    f.act = {Status::Fail("E_BACKEND", "provider error", true)};
    f.Reset();
    std::string r = adl::HandleRequest(ActReq(sid, eid, s.revision, json({{"action", "click"}})), s, b, c, sd);
    CHECK_EQ(Code(r), "E_BACKEND");
    CHECK(MayExec(r));
    CHECK(s.invalidated);
    CHECK(!s.open);
    CHECK_EQ(std::to_string(f.n_close), "1");
    CHECK_EQ(Code(adl::HandleRequest(SnapReq(sid), s, b, c, sd)), "E_NO_SESSION");
  }
  {  // may_have_executed=false: error surfaces, session stays usable
    Fake f; Session s; s.target_id = kTarget;
    Backend b = MakeBackend(f); ControlsTable c = MakeControls();
    bool sd = false;
    std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("FindButton", "button")});
    const std::string eid = s.elements.front().id;
    f.act = {Status::Fail("E_BACKEND", "provider refused", false)};
    f.Reset();
    std::string r = adl::HandleRequest(ActReq(sid, eid, s.revision, json({{"action", "click"}})), s, b, c, sd);
    CHECK_EQ(Code(r), "E_BACKEND");
    CHECK_NOT_CONTAINS(r, "may_have_executed");
    CHECK(!s.invalidated);
    CHECK(s.open);
    CHECK_EQ(std::to_string(f.n_close), "0");
  }
  {  // post-probe itself fails: invalidate with uncertainty
    Fake f; Session s; s.target_id = kTarget;
    Backend b = MakeBackend(f); ControlsTable c = MakeControls();
    bool sd = false;
    std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("FindButton", "button")});
    const std::string eid = s.elements.front().id;
    f.probe = {Status::Ok(), Status::Fail("E_PROBE", "probe unavailable")};
    f.Reset();
    std::string r = adl::HandleRequest(ActReq(sid, eid, s.revision, json({{"action", "click"}})), s, b, c, sd);
    CHECK_EQ(Code(r), "E_PROBE");
    CHECK(MayExec(r));
    CHECK(s.invalidated);
    CHECK(!s.open);
  }
}

void T_output_truncation() {
  g_test = "snapshot_output_bounded_to_64KiB_with_flag";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  bool sd = false;
  std::vector<ElemInfo> big;
  for (int i = 0; i < 300; ++i) {
    ElemInfo e = MakeElem("FindButton", "button", std::string(600, 'a' + (i % 26)));
    e.identity = "idn-" + std::to_string(i);
    big.push_back(e);
  }
  f.snapshots = {big};
  std::string sid = Sid(adl::HandleRequest(OpenReq(), s, b, c, sd));
  std::string r = adl::HandleRequest(SnapReq(sid), s, b, c, sd);
  CHECK_EQ(Code(r), "OK");
  CHECK(r.size() <= static_cast<size_t>(adl::kMaxLineBytes));
  json j = Parse(r);
  CHECK_EQ(j.at("result").at("truncated").get<bool>(), true);
  CHECK(j.at("result").at("elements").size() < 300);
}

void T_close_and_expired() {
  g_test = "close_cleans_up_and_expired_session_denies";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f); ControlsTable c = MakeControls();
  bool sd = false;
  std::string sid = OpenAndSnap(f, s, b, c, {MakeElem("FindButton", "button")});
  f.Reset();
  std::string r = adl::HandleRequest(json{{"op", "close"}, {"request_id", "rc"}, {"target_id", kTarget},
                                          {"session_id", sid}}.dump(), s, b, c, sd);
  CHECK_EQ(Code(r), "OK");
  CHECK_EQ(std::to_string(f.n_close), "1");
  CHECK(sd);
  CHECK(!s.open);
  CHECK_EQ(Code(adl::HandleRequest(SnapReq(sid), s, b, c, sd)), "E_NO_SESSION");
  CHECK_EQ(Code(adl::HandleRequest(ActReq(sid, "e-x", 1, json({{"action", "click"}})), s, b, c, sd)), "E_NO_SESSION");
  // An expired (invalidated) but still-open session denies every op.
  Fake f2; Session s2; s2.target_id = kTarget;
  Backend b2 = MakeBackend(f2);
  bool sd2 = false;
  std::string sid2 = OpenAndSnap(f2, s2, b2, c, {MakeElem("FindButton", "button")});
  f2.Reset(); s2.invalidated = true;  // focus loss detected out of band; session not yet closed
  CHECK_EQ(Code(adl::HandleRequest(SnapReq(sid2), s2, b2, c, sd2)), "E_SESSION_INVALID");
  CHECK_EQ(Code(adl::HandleRequest(ActReq(sid2, "e-x", 1, json({{"action", "click"}})), s2, b2, c, sd2)), "E_SESSION_INVALID");
  CHECK_EQ(std::to_string(f2.n_act + f2.n_snapshot), "0");
}


void T_exact_delimiter_collision() {
 g_test="delimiter_between_fields_preserves_revision";
 auto a=MakeElem("NameEdit","edit","a|b","c");
 auto b=a;b.name="a";b.value="b|c";
 CHECK(ElementFingerprint(a)!=ElementFingerprint(b));
 Session session;SnapshotResult first{{a},false};ApplySnapshot(session,first);
 const auto revision=session.revision;SnapshotResult second{{b},false};ApplySnapshot(session,second);
 CHECK(session.revision>revision);
}
void T_redacted_state_still_changes_revision() {
 g_test="private_secret_change_updates_revision_without_disclosure";
 Fake f;Session s;s.target_id=kTarget;auto backend=MakeBackend(f);auto controls=MakeControls();bool shutdown=false;
 auto secret=MakeElem("ApiKeyInput","edit","Account","PRIVATE_VALUE_A");
 const auto button=MakeElem("FindButton","button","Find");
 const auto sid=OpenAndSnap(f,s,backend,controls,{secret,button});
 const auto revision=s.revision;const auto id=s.elements[1].id;
 secret.value="PRIVATE_VALUE_B";f.snapshots={{secret,button}};f.Reset();
 auto response=HandleRequest(ActReq(sid,id,revision,json{{"action","click"}}),s,backend,controls,shutdown);
 CHECK_EQ(Code(response),"E_STALE_REVISION");CHECK_EQ(f.n_act,0);
 response=HandleRequest(SnapReq(sid),s,backend,controls,shutdown);
 CHECK_NOT_CONTAINS(response,"PRIVATE_VALUE");CHECK_CONTAINS(response,"[redacted]");
}

using ULL = unsigned long long;
TargetObservation Obs(ULL key, ULL start, const std::string& token,
                      const std::string& label = "ADL Fixture") {
  TargetObservation o;
  o.window_key = key; o.process_start = start; o.root_token = token; o.label = label;
  o.x = 10; o.y = 20; o.width = 300; o.height = 200; o.display_ids = {"d-1"};
  return o;
}
std::string DiscReq() { return json{{"op", "discover"}, {"request_id", "rd"}}.dump(); }
std::vector<std::string> Ids(const std::string& resp) {
  std::vector<std::string> ids; json j = Parse(resp);
  if (j.value("ok", false)) for (const json& t : j.at("result").at("targets")) ids.push_back(t.at("target_id").get<std::string>());
  return ids;
}
std::string OpenOn(Broker& br, Fake&, const Backend& b, const ControlsTable& c,
                   const std::string& tid, bool& sd) {
  return Sid(HandleRequest(json{{"op", "open"}, {"request_id", "ro"}, {"mode", "background_semantic"},
                                {"target_id", tid}}.dump(), br, b, c, sd));
}
std::string SnapOn(const std::string& tid, const std::string& sid) {
  return json{{"op", "snapshot"}, {"request_id", "rs"}, {"target_id", tid}, {"session_id", sid}}.dump();
}
std::string CloseOn(const std::string& tid, const std::string& sid) {
  return json{{"op", "close"}, {"request_id", "rc"}, {"target_id", tid}, {"session_id", sid}}.dump();
}
std::string ActOn(const std::string& tid, const std::string& sid, const std::string& eid, long long rev) {
  return json{{"op", "act"}, {"request_id", "ra"}, {"target_id", tid}, {"session_id", sid},
              {"element_id", eid}, {"expected_revision", rev}, {"action", "click"}}.dump();
}
void MakeBroker(Fake& f, Broker& br, const Backend& b, const ControlsTable& c, bool& sd) {
  f.obs = {Obs(0x100, 1000, "r-a"), Obs(0x200, 1000, "r-b")};
  HandleRequest(DiscReq(), br, b, c, sd);
}

void T_v2_same_title_distinct() {
  g_test = "v2_same_title_targets_are_distinct";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  f.obs = {Obs(0x100, 1000, "r-a", "Same"), Obs(0x200, 1000, "r-b", "Same")};
  Broker br;
  const std::string r = HandleRequest(DiscReq(), br, b, c, sd);
  json j = Parse(r);
  CHECK_EQ(Code(r), "OK");
  CHECK_EQ(j.at("result").at("protocol_version").get<int>(), 2);
  CHECK_EQ(j.at("result").at("targets").size(), 2u);
  CHECK(j.at("result").at("mutations_enabled").get<bool>());
  CHECK(j.at("result").at("autofocusing_disabled").get<bool>());
  const json& t0 = j.at("result").at("targets").at(0);
  const json& t1 = j.at("result").at("targets").at(1);
  CHECK(t0.at("target_id") != t1.at("target_id"));
  CHECK_EQ(t0.at("label").get<std::string>(), "Same");
  CHECK_EQ(t1.at("label").get<std::string>(), "Same");
  CHECK_EQ(t0.at("application_id").get<std::string>(), "fixture");
  CHECK_EQ(t0.at("window").at("bounds").at("coordinate_space").get<std::string>(),
           "desktop_physical_pixels");
  CHECK_EQ(t0.at("window").at("bounds").at("x").get<int>(), 10);
  CHECK_EQ(t0.at("window").at("minimized").get<bool>(), false);
  CHECK_EQ(t0.at("window").at("display_ids").size(), 1u);
}

void T_v2_open_exact_forged_retired() {
  g_test = "v2_open_exact_forged_and_retired_denied";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br; MakeBroker(f, br, b, c, sd);
  const std::vector<std::string> ids = Ids(HandleRequest(DiscReq(), br, b, c, sd));
  CHECK_EQ(ids.size(), 2u);
  std::string sid = OpenOn(br, f, b, c, ids[0], sd);
  CHECK(!sid.empty());
  CHECK_EQ(std::to_string(f.n_bind), "1");
  CHECK_EQ(Code(HandleRequest(json{{"op", "open"}, {"request_id", "x"}, {"mode", "background_semantic"},
                                    {"target_id", "t-forged"}}.dump(), br, b, c, sd)), "E_TARGET_NOT_FOUND");
  f.obs = {Obs(0x200, 1000, "r-b")};  // window A closed
  HandleRequest(DiscReq(), br, b, c, sd);
  CHECK_EQ(Code(HandleRequest(json{{"op", "open"}, {"request_id", "y"}, {"mode", "background_semantic"},
                                    {"target_id", ids[0]}}.dump(), br, b, c, sd)), "E_TARGET_NOT_FOUND");
  CHECK_EQ(std::to_string(f.n_bind), "1");
}

void T_v2_sessions_isolation() {
  g_test = "v2_simultaneous_sessions_are_isolated";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br; MakeBroker(f, br, b, c, sd);
  const std::vector<std::string> ids = Ids(HandleRequest(DiscReq(), br, b, c, sd));
  f.snapshots = {{MakeElem("FindButton", "button")}};
  std::string s1 = OpenOn(br, f, b, c, ids[0], sd);
  std::string s2 = OpenOn(br, f, b, c, ids[1], sd);
  CHECK(!s1.empty() && !s2.empty() && s1 != s2);
  CHECK_EQ(br.sessions.size(), 2u);
  f.Reset();
  CHECK_EQ(Code(HandleRequest(SnapOn(ids[1], s1), br, b, c, sd)), "E_TARGET_MISMATCH");
  CHECK_EQ(std::to_string(f.n_snapshot), "0");
  CHECK_EQ(Code(HandleRequest(SnapOn(ids[0], s1), br, b, c, sd)), "OK");
  const std::string e1 = Parse(HandleRequest(SnapOn(ids[0], s1), br, b, c, sd))
                             .at("result").at("elements").at(0).at("id").get<std::string>();
  CHECK_EQ(Code(HandleRequest(ActOn(ids[1], s2, e1, 1), br, b, c, sd)), "E_NO_ELEMENT");
  CHECK_EQ(std::to_string(f.n_act), "0");
}

void T_v2_close_one_keeps_other() {
  g_test = "v2_close_one_session_leaves_the_other_and_helper_alive";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br; MakeBroker(f, br, b, c, sd);
  const std::vector<std::string> ids = Ids(HandleRequest(DiscReq(), br, b, c, sd));
  f.snapshots = {{MakeElem("FindButton", "button")}};
  std::string s1 = OpenOn(br, f, b, c, ids[0], sd);
  std::string s2 = OpenOn(br, f, b, c, ids[1], sd);
  f.Reset();
  CHECK_EQ(Code(HandleRequest(CloseOn(ids[0], s1), br, b, c, sd)), "OK");
  CHECK(!sd);
  CHECK_EQ(std::to_string(f.n_close), "1");
  CHECK_EQ(br.sessions.size(), 1u);
  CHECK_EQ(Code(HandleRequest(SnapOn(ids[1], s2), br, b, c, sd)), "OK");
  CHECK_EQ(Code(HandleRequest(SnapOn(ids[0], s1), br, b, c, sd)), "E_TARGET_MISMATCH");
  br.CloseAll(b);
  CHECK_EQ(std::to_string(f.n_close), "2");
  CHECK_EQ(br.sessions.size(), 0u);
}

void T_v2_close_after_target_retired() {
  g_test = "v2_close_works_after_target_retired_or_session_invalidated";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br; MakeBroker(f, br, b, c, sd);
  const std::vector<std::string> ids = Ids(HandleRequest(DiscReq(), br, b, c, sd));
  std::string s1 = OpenOn(br, f, b, c, ids[0], sd);
  f.obs = {Obs(0x200, 1000, "r-b")};  // only A closes; B remains live
  HandleRequest(DiscReq(), br, b, c, sd);
  f.Reset();
  CHECK_EQ(Code(HandleRequest(CloseOn(ids[0], s1), br, b, c, sd)), "OK");  // close beats liveness gate
  CHECK_EQ(std::to_string(f.n_close), "1");
  CHECK_EQ(br.sessions.size(), 0u);
  const std::string id_b = Ids(HandleRequest(DiscReq(), br, b, c, sd)).at(0);  // B still live
  std::string s2 = OpenOn(br, f, b, c, id_b, sd);
  f.obs = {};  // B closes too; its id retires on the next synchronize
  HandleRequest(DiscReq(), br, b, c, sd);
  CHECK_EQ(Code(HandleRequest(SnapOn(id_b, s2), br, b, c, sd)), "E_TARGET_NOT_FOUND");
  CHECK_EQ(std::to_string(f.n_close), "2");  // the dead session was released, not leaked
  CHECK_EQ(br.sessions.size(), 0u);
}

void T_v2_geometry_stable_id() {
  g_test = "v2_geometry_title_display_updates_keep_target_id";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  f.obs = {Obs(0x100, 1000, "r-a", "Old")};
  Broker br;
  const std::string id1 = Ids(HandleRequest(DiscReq(), br, b, c, sd)).at(0);
  TargetObservation moved = Obs(0x100, 1000, "r-a", "Renamed");
  moved.x = -1920; moved.y = 500; moved.width = 800; moved.height = 600; moved.display_ids = {"d-2", "d-3"};
  f.obs = {moved};
  const std::string id2 = Ids(HandleRequest(DiscReq(), br, b, c, sd)).at(0);
  CHECK(id1 == id2);
  json j = Parse(HandleRequest(DiscReq(), br, b, c, sd));
  CHECK_EQ(j.at("result").at("targets").at(0).at("window").at("bounds").at("x").get<int>(), -1920);
  CHECK_EQ(j.at("result").at("targets").at(0).at("window").at("display_ids").size(), 2u);
  CHECK(!OpenOn(br, f, b, c, id1, sd).empty());
}

void T_v2_root_change_new_id() {
  g_test = "v2_root_element_change_retires_id_forever";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  f.obs = {Obs(0x100, 1000, "r-a")};
  Broker br;
  const std::string id1 = Ids(HandleRequest(DiscReq(), br, b, c, sd)).at(0);
  f.obs = {Obs(0x100, 1000, "r-a2")};  // same HWND, recreated root
  const std::string id2 = Ids(HandleRequest(DiscReq(), br, b, c, sd)).at(0);
  CHECK(id1 != id2);
  CHECK_EQ(Code(HandleRequest(json{{"op", "open"}, {"request_id", "z"}, {"mode", "background_semantic"},
                                    {"target_id", id1}}.dump(), br, b, c, sd)), "E_TARGET_NOT_FOUND");
  f.obs = {Obs(0x100, 1000, "r-a")};  // old token reappears: still a new identity
  const std::string id3 = Ids(HandleRequest(DiscReq(), br, b, c, sd)).at(0);
  CHECK(id3 != id1);
}

void T_v2_no_preferred_fallback() {
  g_test = "v2_no_windows_no_fallback_and_limit_denies";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br;
  f.obs = {};
  json j = Parse(HandleRequest(DiscReq(), br, b, c, sd));
  CHECK_EQ(Code(HandleRequest(DiscReq(), br, b, c, sd)), "OK");
  CHECK_EQ(j.at("result").at("targets").size(), 0u);
  CHECK_EQ(std::to_string(f.n_bind), "0");
  f.obs.clear();
  for (unsigned long long i = 1; i <= 33; ++i) f.obs.push_back(Obs(0x1000 + i, 1000, "r-" + std::to_string(i)));
  CHECK_EQ(Code(HandleRequest(DiscReq(), br, b, c, sd)), "E_TARGET_LIMIT");
  f.obs = {Obs(0x100, 1000, "r-min")};
  f.obs[0].minimized = true;
  const std::string mid = Ids(HandleRequest(DiscReq(), br, b, c, sd)).at(0);
  CHECK_EQ(Code(HandleRequest(json{{"op", "open"}, {"request_id", "m"}, {"mode", "background_semantic"},
                                    {"target_id", mid}}.dump(), br, b, c, sd)), "E_TARGET_NOT_FOUND");
  CHECK_EQ(std::to_string(f.n_bind), "0");
}

void T_v2_capture_contract() {
  g_test="v2_capture_opt_in_exact_binding_and_revalidation";
  Fake f;Backend b=MakeBackend(f);ControlsTable c=MakeControls();bool sd=false;
  f.obs={Obs(0x100,1000,"r-a"),Obs(0x200,1000,"r-b")};Broker br;
  const auto ids=Ids(HandleRequest(DiscReq(),br,b,c,sd));
  const auto sid=OpenOn(br,f,b,c,ids[0],sd);
  auto request=json{{"op","capture"},{"request_id","cap"},{"target_id",ids[0]},{"session_id",sid}};
  CHECK_EQ(Code(HandleRequest(request.dump(),br,b,c,sd)),"E_POLICY_DENIED");
  b.capture=[](void* ctx,Session& session,json& out){auto* f=static_cast<Fake*>(ctx);++f->n_act;
    out={{"png_base64","iVBORw0KGgo="},{"surface_epoch","epoch"},{"target",session.target_id}};return Status::Ok();};
  request["target_id"]=ids[1];
  CHECK_EQ(Code(HandleRequest(request.dump(),br,b,c,sd)),"E_TARGET_MISMATCH");CHECK_EQ(f.n_act,0);
  request["target_id"]=ids[0];request["action"]="click";
  CHECK_EQ(Code(HandleRequest(request.dump(),br,b,c,sd)),"E_BAD_REQUEST");CHECK_EQ(f.n_act,0);
  request.erase("action");const int validations=f.n_revalidate;
  const auto reply=Parse(HandleRequest(request.dump(),br,b,c,sd));CHECK(reply.at("ok")==true);
  CHECK_EQ(reply.at("result").at("target").get<std::string>(),ids[0]);CHECK_EQ(f.n_act,1);
  CHECK_EQ(f.n_revalidate,validations+2);CHECK(!br.sessions.at(sid)->has_revision);
  b.capture=[](void*,Session&,json&){return Status::Fail("E_TIMEOUT","bounded acquisition");};
  CHECK_EQ(Code(HandleRequest(request.dump(),br,b,c,sd)),"E_TIMEOUT");
  b.capture=[](void*,Session&,json& out){out={{"png_base64",std::string(kMaxResponseBytes,'a')}};return Status::Ok();};
  CHECK_EQ(Code(HandleRequest(request.dump(),br,b,c,sd)),"E_RESOURCE_LIMIT");
  b.capture=[](void*,Session&,json& out){out={{"png_base64","must-not-return"}};return Status::Ok();};
  b.revalidate=[](void* ctx,Session&){auto* f=static_cast<Fake*>(ctx);++f->n_revalidate;
    return f->n_revalidate%2==0?Status::Fail("E_TARGET_NOT_FOUND","closed during capture"):Status::Ok();};
  f.n_revalidate=0;
  const auto closed=HandleRequest(request.dump(),br,b,c,sd);
  CHECK_EQ(Code(closed),"E_TARGET_NOT_FOUND");CHECK_NOT_CONTAINS(closed,"must-not-return");
}

void T_v2_interactive_mode_contract() {
  g_test="v2_interactive_mode_is_opt_in_and_operations_are_session_scoped";
  Fake f;Backend b=MakeBackend(f);ControlsTable c=MakeControls();bool sd=false;f.obs={Obs(0x100,1000,"root")};Broker br;
  const auto target=Ids(HandleRequest(DiscReq(),br,b,c,sd))[0];
  json open{{"op","open"},{"request_id","input-open"},{"target_id",target},{"mode","interactive_desktop"}};
  CHECK_EQ(Code(HandleRequest(open.dump(),br,b,c,sd)),"E_POLICY_DENIED");CHECK_EQ(f.n_bind,0);
  const auto background=OpenOn(br,f,b,c,target,sd);
  b.input_operation=[](void* ctx,Session& session,const json& doc,const ControlsTable&,json& out){
    ++static_cast<Fake*>(ctx)->n_act;out={{"mode",session.mode},{"op",doc["op"]},{"released_input",true}};return Status::Ok();};
  b.gesture_backends={"mouse_drag","scroll_swipe"};
  const auto d=Parse(HandleRequest(DiscReq(),br,b,c,sd));CHECK(d["result"]["interactive_input"]==true);CHECK_EQ(d["result"]["gesture_backends"].size(),2u);
  CHECK(d["result"]["targets"][0]["interactive_input"]==true);
  const auto sid=Sid(HandleRequest(open.dump(),br,b,c,sd));CHECK(!sid.empty());CHECK_EQ(br.sessions.at(sid)->mode,"interactive_desktop");
  for(const auto* op:{"gesture","prepare_input","commit_input"}){
    json req{{"op",op},{"request_id","input"},{"target_id",target},{"session_id",background}};
    CHECK_EQ(Code(HandleRequest(req.dump(),br,b,c,sd)),"E_POLICY_DENIED");req["session_id"]=sid;
    const auto reply=Parse(HandleRequest(req.dump(),br,b,c,sd));CHECK(reply["ok"]==true);CHECK_EQ(reply["result"]["mode"].get<std::string>(),"interactive_desktop");
    req["target_id"]="t-foreign";CHECK_EQ(Code(HandleRequest(req.dump(),br,b,c,sd)),"E_TARGET_MISMATCH");
  }
  CHECK_EQ(f.n_act,3);
  json act{{"op","act"},{"request_id","old-act"},{"target_id",target},{"session_id",sid},{"action","click"},{"element_id","none"},{"expected_revision",1}};
  CHECK_EQ(Code(HandleRequest(act.dump(),br,b,c,sd)),"E_POLICY_DENIED");CHECK_EQ(f.n_act,3);
  b.input_operation=[](void*,Session&,const json&,const ControlsTable&,json&){return Status::Fail("E_CANCELLED","released after cancellation",true);};
  json cancel{{"op","gesture"},{"request_id","cancel"},{"target_id",target},{"session_id",sid}};
  const auto cancelled=HandleRequest(cancel.dump(),br,b,c,sd);CHECK_EQ(Code(cancelled),"E_CANCELLED");CHECK(MayExec(cancelled));
}

std::string AppReq(const std::string& action) {
  return json{{"op", "application"}, {"request_id", "ra"}, {"action", action}}.dump();
}
std::string AppReqWith(const std::string& field, const json& value) {
  json j{{"op", "application"}, {"request_id", "ra"}, {"action", "status"}};
  j[field] = value;
  return j.dump();
}
// The three lifecycle facts as "running,managed,changed" for compact assertions.
std::string Flags(const std::string& response) {
  const json j = Parse(response);
  if (!j.value("ok", false)) return "error";
  const json& r = j.at("result");
  return std::string(r.at("running").get<bool>() ? "1" : "0") + "," +
         (r.at("managed").get<bool>() ? "1" : "0") + "," + (r.at("changed").get<bool>() ? "1" : "0");
}

void T_lifecycle_opt_out_denies() {
  g_test = "lifecycle_without_launch_opt_in_denies_and_never_dispatches";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br;
  CHECK(b.application == nullptr);
  for (const char* action : {"status", "launch", "quit"}) {
    const std::string r = HandleRequest(AppReq(action), br, b, c, sd);
    CHECK_EQ(Code(r), "E_POLICY_DENIED");
    CHECK_NOT_CONTAINS(r, "may_have_executed");
  }
  CHECK_EQ(std::to_string(f.n_application), "0");
  CHECK_EQ(std::to_string(f.n_enumerate + f.n_bind + f.n_close), "0");
  // Existing routes are untouched by the new op.
  f.obs = {Obs(0x100, 1000, "r-a")};
  CHECK_EQ(Code(HandleRequest(DiscReq(), br, b, c, sd)), "OK");
  CHECK(!OpenOn(br, f, b, c, Ids(HandleRequest(DiscReq(), br, b, c, sd))[0], sd).empty());
  CHECK_EQ(std::to_string(f.n_application), "0");
}

void T_lifecycle_sessionless_results() {
  g_test = "lifecycle_status_launch_idempotent_quit_are_sessionless";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br;  // no discover, no open: the call needs no session or target
  EnableLifecycle(f, b);
  f.app_result = {{false, false, false}};
  CHECK_EQ(Flags(HandleRequest(AppReq("status"), br, b, c, sd)), "0,0,0");
  f.app_result = {{true, true, true}};
  CHECK_EQ(Flags(HandleRequest(AppReq("launch"), br, b, c, sd)), "1,1,1");
  f.app_result = {{true, true, false}};  // idempotent: the owned process was already live
  CHECK_EQ(Flags(HandleRequest(AppReq("launch"), br, b, c, sd)), "1,1,0");
  f.app_result = {{false, false, true}};
  CHECK_EQ(Flags(HandleRequest(AppReq("quit"), br, b, c, sd)), "0,0,1");
  CHECK_EQ(std::to_string(f.n_application), "4");
  CHECK_EQ(f.app_actions[0], "status");
  CHECK_EQ(f.app_actions[1], "launch");
  CHECK_EQ(f.app_actions[2], "launch");
  CHECK_EQ(f.app_actions[3], "quit");
  CHECK_EQ(std::to_string(f.n_enumerate + f.n_bind + f.n_snapshot + f.n_close), "0");
  const json j = Parse(HandleRequest(AppReq("status"), br, b, c, sd));
  CHECK_EQ(j.at("request_id").get<std::string>(), "ra");
  CHECK_EQ(j.at("result").size(), 3u);  // exactly running, managed, changed
}

void T_lifecycle_action_validation() {
  g_test = "lifecycle_missing_nonstring_or_unknown_action_never_dispatches";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br;
  EnableLifecycle(f, b);
  const std::string cases[] = {
      json{{"op", "application"}, {"request_id", "ra"}}.dump(),                     // missing
      json{{"op", "application"}, {"request_id", "ra"}, {"action", 4}}.dump(),      // non-string
      json{{"op", "application"}, {"request_id", "ra"}, {"action", json()}}.dump(),  // null
      json{{"op", "application"}, {"request_id", "ra"}, {"action", ""}}.dump(),      // empty
      json{{"op", "application"}, {"request_id", "ra"}, {"action", "Status"}}.dump(),  // case sensitive
      json{{"op", "application"}, {"request_id", "ra"}, {"action", "restart"}}.dump(),
      json{{"op", "application"}, {"request_id", "ra"}, {"action", "terminate"}}.dump(),
      json{{"op", "application"}, {"request_id", "ra"}, {"action", std::string("a\0b", 3)}}.dump(),  // NUL
      json{{"op", "application"}, {"request_id", "ra"}, {"action", "status extra"}}.dump(),
  };
  for (const std::string& request : cases) {
    const std::string r = HandleRequest(request, br, b, c, sd);
    CHECK_EQ(Code(r), "E_BAD_REQUEST");
    CHECK_NOT_CONTAINS(r, "may_have_executed");
  }
  CHECK_EQ(std::to_string(f.n_application), "0");
}

void T_lifecycle_extraneous_fields_denied() {
  g_test = "lifecycle_rejects_any_target_session_or_command_field";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br;
  EnableLifecycle(f, b);
  const char* const fields[] = {"target_id", "session_id", "element_id", "expected_revision",
                                "mode", "value", "checked", "direction", "input_token",
                                "surface_id", "kind", "points", "swipe_backend", "point",
                                "expected_target", "confirmation_id", "path", "pid",
                                "executable", "command", "arguments", "desktop"};
  for (const char* field : fields) {
    const std::string r = HandleRequest(AppReqWith(field, json("x")), br, b, c, sd);
    if (Code(r) != "E_BAD_REQUEST") Fail(__LINE__, std::string(field) + " accepted", Code(r));
    CHECK_NOT_CONTAINS(r, "may_have_executed");
  }
  // A non-string extraneous value is denied too, and nothing dispatches.
  CHECK_EQ(Code(HandleRequest(AppReqWith("target_id", json(7)), br, b, c, sd)), "E_BAD_REQUEST");
  CHECK_EQ(std::to_string(f.n_application), "0");
  CHECK_EQ(Flags(HandleRequest(AppReq("status"), br, b, c, sd)), "0,0,0");  // exact keys still work
}

void T_lifecycle_error_uncertainty() {
  g_test = "lifecycle_backend_error_propagates_code_and_may_have_executed";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br;
  EnableLifecycle(f, b);
  f.app_status = {Status::Fail("E_LIFECYCLE_REFUSED", "a modal dialog is open")};
  const std::string refused = HandleRequest(AppReq("quit"), br, b, c, sd);
  CHECK_EQ(Code(refused), "E_LIFECYCLE_REFUSED");
  CHECK_NOT_CONTAINS(refused, "may_have_executed");
  CHECK_EQ(Flags(refused), "error");
  f.app_status = {Status::Fail("E_CANCELLED", "cancelled after the close was requested", true)};
  const std::string cancelled = HandleRequest(AppReq("quit"), br, b, c, sd);
  CHECK_EQ(Code(cancelled), "E_CANCELLED");
  CHECK(MayExec(cancelled));
  f.app_status = {Status::Fail("E_LIFECYCLE_TIMEOUT", "still running", true)};
  CHECK(MayExec(HandleRequest(AppReq("quit"), br, b, c, sd)));
  CHECK_EQ(std::to_string(f.n_application), "3");
  CHECK_EQ(std::to_string(f.n_close), "0");  // an error never releases sessions
}

void T_lifecycle_quit_releases_state() {
  g_test = "lifecycle_quit_clears_sessions_and_targets_then_discovers_again";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Broker br;
  EnableLifecycle(f, b);
  f.obs = {Obs(0x100, 1000, "r-a"), Obs(0x200, 1000, "r-b")};
  const std::vector<std::string> ids = Ids(HandleRequest(DiscReq(), br, b, c, sd));
  f.snapshots = {{MakeElem("FindButton", "button")}};
  const std::string s1 = OpenOn(br, f, b, c, ids[0], sd);
  const std::string s2 = OpenOn(br, f, b, c, ids[1], sd);
  CHECK_EQ(br.sessions.size(), 2u);
  // A launch, and a quit that changed nothing, keep the observed state.
  f.app_result = {{true, true, false}};
  CHECK_EQ(Flags(HandleRequest(AppReq("launch"), br, b, c, sd)), "1,1,0");
  CHECK_EQ(br.sessions.size(), 2u);
  f.app_result = {{true, true, false}};
  CHECK_EQ(Flags(HandleRequest(AppReq("quit"), br, b, c, sd)), "1,1,0");
  CHECK_EQ(br.sessions.size(), 2u);
  CHECK_EQ(std::to_string(f.n_close), "0");
  // A confirmed quit releases both sessions and retires both target ids.
  f.app_result = {{false, false, true}};
  CHECK_EQ(Flags(HandleRequest(AppReq("quit"), br, b, c, sd)), "0,0,1");
  CHECK_EQ(br.sessions.size(), 0u);
  CHECK_EQ(std::to_string(f.n_close), "2");
  CHECK_EQ(br.registry.live_count(), 0u);
  f.Reset();
  CHECK_EQ(Code(HandleRequest(SnapOn(ids[0], s1), br, b, c, sd)), "E_TARGET_MISMATCH");
  CHECK_EQ(Code(HandleRequest(ActOn(ids[1], s2, "e-x", 1), br, b, c, sd)), "E_TARGET_MISMATCH");
  CHECK_EQ(Code(HandleRequest(CloseOn(ids[0], s1), br, b, c, sd)), "E_TARGET_MISMATCH");
  CHECK_EQ(std::to_string(f.n_snapshot + f.n_act + f.n_close + f.n_revalidate), "0");
  // Discovery after the quit works and hands out fresh ids.
  const std::vector<std::string> again = Ids(HandleRequest(DiscReq(), br, b, c, sd));
  CHECK_EQ(again.size(), 2u);
  CHECK(again[0] != ids[0] && again[1] != ids[1]);
  CHECK(!OpenOn(br, f, b, c, again[0], sd).empty());
  CHECK_EQ(Code(HandleRequest(SnapOn(again[0], OpenOn(br, f, b, c, again[0], sd)), br, b, c, sd)), "OK");
}

void T_lifecycle_legacy_route_unsupported() {
  g_test = "lifecycle_on_legacy_v1_route_is_unsupported_and_undispatched";
  Fake f; Backend b = MakeBackend(f); ControlsTable c = MakeControls(); bool sd = false;
  Session s; s.target_id = kTarget;
  EnableLifecycle(f, b);
  CHECK_EQ(Code(HandleRequest(AppReq("status"), s, b, c, sd)), "E_UNSUPPORTED_ACTION");
  CHECK_EQ(Code(HandleRequest(AppReq("launch"), s, b, c, sd)), "E_UNSUPPORTED_ACTION");
  CHECK_EQ(std::to_string(f.n_application), "0");
  // The legacy route still serves its own ops unchanged.
  CHECK_EQ(Code(HandleRequest(OpenReq(), s, b, c, sd)), "OK");
  CHECK_EQ(Code(HandleRequest(SnapReq(s.session_id), s, b, c, sd)), "OK");
}

// --- trusted --allow-all launch mode (argv only; never a protocol field) ---
void T_allow_all_default_and_strict_denial() {
  g_test = "allow_all_defaults_false_and_strict_denies_unlisted_submit";
  ControlsTable fresh;
  CHECK(!fresh.allow_all);            // opt-in only, never implied by an empty table
  ControlsTable c = MakeControls();
  CHECK(!c.allow_all);                // a loaded controls file cannot enable it either
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f);
  bool sd = false;
  ElemInfo e = MakeElem("", "button", "Submit Form");
  ElemInfo plain = MakeElem("", "button", "Find");
  plain.identity = "idn-plain";  // distinct element identity, same empty AutomationId
  std::string sid = OpenAndSnap(f, s, b, c, {e, plain});
  const std::string eid = s.elements[0].id, pid = s.elements[1].id;
  const long long rev = s.revision;
  json forged = Parse(ActReq(sid, eid, rev, json({{"action", "click"}})));
  forged["allow_all"] = true;         // the protocol exposes no broad-mode input
  CHECK_EQ(Code(adl::HandleRequest(forged.dump(), s, b, c, sd)), "E_BAD_REQUEST");
  CHECK_EQ(Code(adl::HandleRequest(ActReq(sid, eid, rev, json({{"action", "click"}})), s, b, c, sd)),
           "E_CONTROL_BLOCKED");       // consequential label still denied in strict mode
  ControlsTable empty;                 // strict mode with no policy at all: an
  CHECK_EQ(Code(adl::HandleRequest(ActReq(sid, pid, rev, json({{"action", "click"}})), s, b, empty, sd)),
           "E_NOT_ALLOWED");           // unlisted control with an empty AutomationId is denied
  CHECK_EQ(std::to_string(f.n_act + f.n_probe), "0");
  CHECK(s.open);
}

void T_allow_all_permits_unlisted_controls() {
  g_test = "allow_all_empty_table_permits_supported_enabled_action";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f);
  ControlsTable c; c.allow_all = true;  // no policy/controls file needed
  bool sd = false;
  ElemInfo submit = MakeElem("", "button", "Submit Form");
  ElemInfo api = MakeElem("ApiKeyInput", "edit", "API Key");
  api.sensitive = true;
  std::string sid = OpenAndSnap(f, s, b, c, {submit, api});
  const long long rev = s.revision;
  const std::string submit_id = s.elements[0].id, api_id = s.elements[1].id;
  f.Reset();
  CHECK_EQ(Code(adl::HandleRequest(ActReq(sid, submit_id, rev, json({{"action", "click"}})), s, b, c, sd)),
           "OK");
  CHECK_EQ(Code(adl::HandleRequest(
               ActReq(sid, api_id, rev, json({{"action", "fill"}, {"value", "hello"}})), s, b, c, sd)),
           "OK");
  CHECK_EQ(std::to_string(f.n_act), "2");
  CHECK_EQ(f.acts[0].expected_role, "button");  // expected role is the latest observed role
  CHECK_EQ(f.acts[1].expected_role, "edit");
  CHECK(f.acts[0].automation_id.empty());       // an empty AutomationId is not a restriction
  CHECK(s.open);
}

void T_allow_all_keeps_state_guards() {
  g_test = "allow_all_still_denies_disabled_stale_unknown_and_unsupported";
  Fake f; Session s; s.target_id = kTarget;
  Backend b = MakeBackend(f);
  ControlsTable c; c.allow_all = true;
  bool sd = false;
  ElemInfo off = MakeElem("", "button", "Submit Form");
  off.enabled = false;
  ElemInfo live = MakeElem("", "button", "Submit Form");
  live.identity = "idn-live";  // distinct element identity, same empty AutomationId
  std::string sid = OpenAndSnap(f, s, b, c, {off, live});
  const std::string eid = s.elements[0].id;
  const long long rev = s.revision;
  f.Reset();
  CHECK_EQ(Code(adl::HandleRequest(ActReq(sid, eid, rev, json({{"action", "click"}})), s, b, c, sd)),
           "E_NOT_ENABLED");
  CHECK_EQ(Code(adl::HandleRequest(ActReq(sid, eid, rev + 1, json({{"action", "click"}})), s, b, c, sd)),
           "E_STALE_REVISION");
  CHECK_EQ(Code(adl::HandleRequest(ActReq(sid, "e-nope", rev, json({{"action", "click"}})), s, b, c, sd)),
           "E_NO_ELEMENT");
  CHECK_EQ(Code(adl::HandleRequest(ActReq(sid, eid, rev, json({{"action", "explode"}})), s, b, c, sd)),
           "E_BAD_REQUEST");
  CHECK_EQ(Code(adl::HandleRequest(
               ActReq(sid, eid, rev, json({{"action", "click"}, {"value", "x"}})), s, b, c, sd)),
           "E_BAD_REQUEST");
  CHECK_EQ(std::to_string(f.n_act + f.n_probe + f.n_close), "0");
  CHECK(s.open);
  // A focus change during the completion interval still invalidates in broad mode.
  f.probes = {{100, "before"}, {101, "after"}};
  const std::string live_id = s.elements[1].id;
  std::string r = adl::HandleRequest(ActReq(sid, live_id, s.revision, json({{"action", "click"}})),
                                     s, b, c, sd);
  CHECK_EQ(Code(r), "E_FOCUS_CHANGED");
  CHECK(MayExec(r));
  CHECK(!s.open);
}

struct TestCase { const char* name; void (*fn)(); };
const TestCase kTests[] = {
    {"lifecycle_without_launch_opt_in_denies_and_never_dispatches", T_lifecycle_opt_out_denies},
    {"lifecycle_status_launch_idempotent_quit_are_sessionless", T_lifecycle_sessionless_results},
    {"lifecycle_missing_nonstring_or_unknown_action_never_dispatches", T_lifecycle_action_validation},
    {"lifecycle_rejects_any_target_session_or_command_field", T_lifecycle_extraneous_fields_denied},
    {"lifecycle_backend_error_propagates_code_and_may_have_executed", T_lifecycle_error_uncertainty},
    {"lifecycle_quit_clears_sessions_and_targets_then_discovers_again", T_lifecycle_quit_releases_state},
    {"lifecycle_on_legacy_v1_route_is_unsupported_and_undispatched", T_lifecycle_legacy_route_unsupported},
    {"v2_interactive_mode_is_opt_in_and_operations_are_session_scoped", T_v2_interactive_mode_contract},
    {"v2_capture_opt_in_exact_binding_and_revalidation", T_v2_capture_contract},
    {"exact_delimiter_collision", T_exact_delimiter_collision},
    {"secret_change_updates_private_revision", T_redacted_state_still_changes_revision},
    {"strict_isolated_denied_before_bind", T_strict_isolated},
    {"wrong_target_or_session_no_side_effects", T_target_session_mismatch},
    {"fill_check_direction_nul_rejected_before_backend", T_argument_validation},
    {"policy_denials_before_act", T_policy_denials},
    {"snapshot_suppresses_secret_name_and_value", T_secrets_suppressed},
    {"revision_stable_until_tree_changes", T_revision_stability},
    {"external_change_before_act_rejects_stale_before_dispatch", T_stale_before_dispatch},
    {"separator_names_cannot_collide_signature", T_separator_collision},
    {"successful_fill_and_click_delegate_exactly_once", T_success_delegates_once},
    {"post_probe_change_invalidates_with_uncertainty", T_focus_change_invalidates},
    {"delayed_post_probe_change_invalidates_with_uncertainty", T_delayed_focus_change_invalidates},
    {"failed_action_may_have_executed_invalidates", T_failed_action_uncertainty},
    {"snapshot_output_bounded_to_64KiB_with_flag", T_output_truncation},
    {"close_cleans_up_and_expired_session_denies", T_close_and_expired},
    {"v2_same_title_targets_are_distinct", T_v2_same_title_distinct},
    {"v2_open_exact_forged_and_retired_denied", T_v2_open_exact_forged_retired},
    {"v2_simultaneous_sessions_are_isolated", T_v2_sessions_isolation},
    {"v2_close_one_session_leaves_the_other_and_helper_alive", T_v2_close_one_keeps_other},
    {"v2_close_works_after_target_retired_or_session_invalidated", T_v2_close_after_target_retired},
    {"v2_geometry_title_display_updates_keep_target_id", T_v2_geometry_stable_id},
    {"v2_root_element_change_retires_id_forever", T_v2_root_change_new_id},
    {"v2_no_windows_no_fallback_and_limit_denies", T_v2_no_preferred_fallback},
    {"allow_all_defaults_false_and_strict_denies_unlisted_submit", T_allow_all_default_and_strict_denial},
    {"allow_all_empty_table_permits_supported_enabled_action", T_allow_all_permits_unlisted_controls},
    {"allow_all_still_denies_disabled_stale_unknown_and_unsupported", T_allow_all_keeps_state_guards},
};

}  // namespace

int main() {
  g_test="sensitive_label_boundaries_and_japanese";
  for(const auto* label:{"Shipping address","Author","spinbutton","monkey","Quantity"})CHECK(!IsSensitiveText(label));
  for(const auto* label:{"PIN","auth","api_key","access-token","accessToken","newPassword","ApiKeyInput","apiKey1","password1","accessToken2","dummy@example.com",u8"暗証番号",u8"パスワード",u8"認証コード",u8"ＡＰＩキー",u8"apiキー"})CHECK(IsSensitiveText(label));
  for (const TestCase& t : kTests) {
    int before = g_failures;
    try { t.fn(); } catch(const std::exception& e) { Fail(__LINE__,"uncaught test exception",e.what()); }
    std::printf("%-60s %s\n", t.name, g_failures == before ? "PASS" : "FAIL");
    std::fflush(stdout);
  }
  if (g_failures) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all %zu tests passed\n", sizeof(kTests) / sizeof(kTests[0]));
  return 0;
}
