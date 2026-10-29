// Windows UIA backend: exact process/window binding, read-only snapshots and
// pattern-only semantic mutations by default. Physical input requires the
// separate trusted interactive_desktop lease and current observation proof.
#include <windows.h>
#include <objbase.h>
#include <oleauto.h>
#include <UIAutomation.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cwctype>
#include <deque>
#include <map>
#include <string>
#include <iterator>
#include <new>
#include <unordered_map>
#include <vector>

#include "protocol.h"
#include "uia_backend.h"
#include "window_lifetime.h"
#include "focus_identity.h"
#include "window_capture.h"
#include <dwmapi.h>
#include "input_monitor.h"
#include "human_focus_probe.h"
#include "value_text.h"
#include <set>
#include <cmath>

namespace adl {
namespace {

using Microsoft::WRL::ComPtr;

// One window retained by the native registry: exact HWND plus the process
// handle whose creation FILETIME produced the identity, plus the root element
// whose CompareElements result defines the stable root_token.
struct RetainedTarget {
  HWND hwnd = nullptr;
  DWORD pid = 0;
  HANDLE process = nullptr;            // retained until the window closes or the root changes
  unsigned long long start = 0;        // creation FILETIME of that process handle
  std::wstring exe_path;               // actual canonical path retained per target
  ComPtr<IUIAutomationElement> root;   // retained root element
  std::string root_token;              // private UUID, stable while root compares equal
  std::shared_ptr<std::atomic<bool>> destroyed;
};

struct InputSurface {std::string id;RECT region{};bool drag=false,swipe=false;std::string swipe_backend;};
struct SelectionProof {bool supported=false;std::vector<ComPtr<IUIAutomationTextRange>> ranges;};
struct InputProof {SelectionProof selection;std::string token;RECT bounds{};ULONGLONG tick=0,human_sequence=0;long long revision=0;POINT cursor{};ComPtr<IUIAutomationElement> focused;};
struct InputConfirmation {
  std::string id,action,fingerprint,automation_id,role,name;ComPtr<IUIAutomationElement> element,focused_before;
  RECT bounds{},element_bounds{};POINT point{};ULONGLONG expires=0,human_sequence=0;bool editable=false;SelectionProof focused_selection,target_selection;
};
struct Impl {
  std::string app_id;
  bool visual_enabled = false;
  bool lifecycle_enabled = false;
  bool allow_all = false;  // trusted --allow-all: any current-user desktop window
  bool restrict_targets = false;
  bool tier = false;  // trusted --operation-mode standard|ask: vocabulary-gated, no allowlist
  std::unique_ptr<HumanFocusProbe> human_probe;
  HANDLE owned_process=nullptr;
  DWORD owned_pid=0;
  unsigned long long owned_start=0;
  bool interactive_enabled=false,input_leased=false;
  std::vector<InputSurface> input_surfaces;
  InputMonitor input_monitor;
  std::atomic<bool> local_cancelled{false};std::atomic<bool>* input_cancelled=&local_cancelled;
  std::wstring want_path;  // canonical executable path from our own argv
  WindowLifetimeMonitor lifetime;
  ComPtr<IUnknown> app;
  ComPtr<IUIAutomation2> uia;
  std::map<std::pair<unsigned long long, unsigned long long>, RetainedTarget> targets;  // (hwnd, start)
};

// Per opened session state: its own process handle and root element, so one
// session closing never releases another session's resources.
struct SessionState {
  std::unique_ptr<InputLease> input_lease;
  ULONGLONG lease_human_sequence=0;
  InputProof input_proof;
  InputConfirmation confirmation;
  DWORD pid = 0;
  HANDLE process = nullptr;
  std::shared_ptr<std::atomic<bool>> destroyed;
  std::string binding_token;
  std::wstring exe_path;  // actual canonical path of the bound process, rechecked
  std::string visual_epoch;
  RECT visual_bounds{};
  ComPtr<IUIAutomationElement> root;
  std::unordered_map<std::string, ComPtr<IUIAutomationElement>> by_identity;
  struct Identity { ComPtr<IUIAutomationElement> element; std::string token; };
  std::unordered_map<std::string, Identity> identities, previous_identities;
};

SessionState* StateOf(const Session& s) { return static_cast<SessionState*>(s.impl); }

std::string ToUtf8(BSTR w) {
  if (!w) return std::string();
  const UINT chars = SysStringLen(w);
  if (chars > 4096) return "[oversize]";
  if (chars == 0) return std::string();
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, static_cast<int>(chars), nullptr, 0, nullptr, nullptr);
  if (n <= 0) return std::string();
  std::string s(static_cast<size_t>(n), '\0');
  if (WideCharToMultiByte(CP_UTF8, 0, w, static_cast<int>(chars), &s[0], n, nullptr, nullptr) != n)
    return std::string();
  return s;
}

std::wstring ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  if (s.find('\0') != std::string::npos) return std::wstring();
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (n <= 0 || n > 4096) return std::wstring();
  std::wstring w(static_cast<size_t>(n), L'\0');
  if (MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), &w[0], n) != n)
    return std::wstring();
  return w;
}

std::string Hex(const void* p) {
  char buf[32];
  snprintf(buf, sizeof buf, "0x%llx", (unsigned long long)(uintptr_t)p);
  return buf;
}

std::wstring Normalise(std::wstring p) {
  for (wchar_t& c : p)
    if (c == L'/') c = L'\\';
  if (p.compare(0, 4, L"\\\\?\\") == 0) p.erase(0, 4);
  if (p.compare(0, 4, L"\\??\\") == 0) p.erase(0, 4);
  while (p.size() > 3 && p.back() == L'\\') p.pop_back();
  std::transform(p.begin(), p.end(), p.begin(), [](wchar_t c) { return (wchar_t)towlower(c); });
  return p;
}

std::wstring ExePathOf(DWORD pid) {
  const HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return std::wstring();
  wchar_t buf[4096];
  DWORD n = (DWORD)(sizeof buf / sizeof buf[0]);
  std::wstring exe;
  if (QueryFullProcessImageNameW(h, 0, buf, &n)) exe = Normalise(std::wstring(buf, n));
  CloseHandle(h);
  return exe;
}

// Resolves the target by exact canonical executable path only.
std::wstring CanonicalPath(const std::wstring& path) {
  const HANDLE h = CreateFileW(path.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr,
                               OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (h == INVALID_HANDLE_VALUE) return std::wstring();
  wchar_t buf[4096];
  const DWORD n = GetFinalPathNameByHandleW(h, buf, (DWORD)(sizeof buf / sizeof buf[0]),
                                            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  CloseHandle(h);
  if (n == 0 || n >= sizeof buf / sizeof buf[0]) return std::wstring();
  return Normalise(std::wstring(buf, n));
}

// Collects every visible unowned top-level window of the exact canonical exe.
// No scoring, no preferred candidate: each window becomes its own target.
struct EnumContext {
  const std::wstring* want_path;
  bool allow_all=false;
  DWORD only_pid=0;
  std::vector<HWND> hwnds;
};

BOOL CALLBACK CollectCandidates(HWND hwnd, LPARAM lp) {
  EnumContext* out = reinterpret_cast<EnumContext*>(lp);
  const std::wstring* g_want_path = out->want_path;
  if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (!pid) return TRUE;
  if(out->only_pid&&pid!=out->only_pid)return TRUE;
  const std::wstring exe = ExePathOf(pid);
  if (exe.empty()) return TRUE;  // unattributable process: never a target
  if (!out->allow_all && _wcsicmp(exe.c_str(), g_want_path->c_str()) != 0) return TRUE;
  if (out->hwnds.size() < kMaxTargets + 1) out->hwnds.push_back(hwnd);
  return TRUE;
}

bool ProcessStartHandle(HANDLE h, unsigned long long& start) {
  start = 0;
  FILETIME c, e, k, u;
  if (!h || !GetProcessTimes(h, &c, &e, &k, &u)) return false;
  ULARGE_INTEGER v;
  v.HighPart = c.dwHighDateTime;
  v.LowPart = c.dwLowDateTime;
  start = v.QuadPart;
  return true;
}

std::wstring ExePathFromHandle(HANDLE h) {
  wchar_t buf[4096];
  DWORD n = static_cast<DWORD>(sizeof(buf) / sizeof(buf[0]));
  if (!QueryFullProcessImageNameW(h, 0, buf, &n)) return std::wstring();
  return Normalise(std::wstring(buf, n));
}

// One IUIAutomation2 (CUA) object per helper process, created on the MTA
// thread that also serves requests. AutoSetFocus must be off before use.
Status EnsureUia(Impl* im) {
  if (im->uia) {
    BOOL current = TRUE;
    if (FAILED(im->uia->get_AutoSetFocus(&current)) || current != FALSE)
      return Status::Fail("E_UIA_INIT", "UIA AutoSetFocus verification failed");
    return Status::Ok();
  }
  ComPtr<IUnknown> app;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER,
                             IID_PPV_ARGS(app.GetAddressOf()))) || !app)
    return Status::Fail("E_UIA_INIT", "UI Automation is unavailable on this host");
  ComPtr<IUIAutomation2> uia;
  if (FAILED(app.As(&uia)) || !uia)
    return Status::Fail("E_UIA_INIT", "IUIAutomation2 is unavailable");
  if (FAILED(uia->put_AutoSetFocus(FALSE)))
    return Status::Fail("E_UIA_INIT", "cannot disable UIA AutoSetFocus");
  BOOL focus = TRUE;
  if (FAILED(uia->get_AutoSetFocus(&focus)) || focus != FALSE)
    return Status::Fail("E_UIA_INIT", "UIA AutoSetFocus verification failed");
  im->app = app;
  im->uia = uia;
  return Status::Ok();
}

std::string IdentityOf(IUIAutomationElement* el) {
  SAFEARRAY* ra = nullptr;
  if (SUCCEEDED(el->GetRuntimeId(&ra)) && ra) {
    long lo = 0, hi = -1;
    SafeArrayGetLBound(ra, 1, &lo);
    SafeArrayGetUBound(ra, 1, &hi);
    std::string out = "r:";
    char b[12];
    for (long i = lo; i <= hi && i - lo < 24; ++i) {
      int v = 0;
      LONG index = i;
      if (SUCCEEDED(SafeArrayGetElement(ra, &index, &v))) {
        snprintf(b, sizeof b, "%08x", (unsigned)v);
        out += b;
      }
    }
    SafeArrayDestroy(ra);
    if (out.size() > 2) return out;
  }
  return "p:" + Hex((void*)el);
}

std::string RoleName(int id) {
  switch (id) {
    case UIA_ButtonControlTypeId: return "button";
    case UIA_CheckBoxControlTypeId: return "checkbox";
    case UIA_ComboBoxControlTypeId: return "combobox";
    case UIA_EditControlTypeId: return "edit";
    case UIA_HyperlinkControlTypeId: return "hyperlink";
    case UIA_ListItemControlTypeId: return "listitem";
    case UIA_MenuControlTypeId: return "menu";
    case UIA_MenuItemControlTypeId: return "menuitem";
    case UIA_RadioButtonControlTypeId: return "radiobutton";
    case UIA_ScrollBarControlTypeId: return "scrollbar";
    case UIA_SliderControlTypeId: return "slider";
    case UIA_SpinnerControlTypeId: return "spinner";
    case UIA_TabControlTypeId: return "tab";
    case UIA_TabItemControlTypeId: return "tabitem";
    case UIA_TextControlTypeId: return "text";
    case UIA_ToolBarControlTypeId: return "toolbar";
    case UIA_TreeControlTypeId: return "tree";
    case UIA_TreeItemControlTypeId: return "treeitem";
    case UIA_WindowControlTypeId: return "window";
    case UIA_PaneControlTypeId: return "pane";
    case UIA_GroupControlTypeId: return "group";
    case UIA_DocumentControlTypeId: return "document";
    case UIA_DataItemControlTypeId: return "dataitem";
    default: return "unknown";
  }
}

bool TryTextOf(IUIAutomationElement* el, HRESULT (STDMETHODCALLTYPE IUIAutomationElement::*get)(BSTR*), std::string& out) {
  BSTR b = nullptr;
  const HRESULT hr = (el->*get)(&b);
  out = ToUtf8(b);
  if (b) SysFreeString(b);
  return SUCCEEDED(hr) && out != "[oversize]";
}

std::string LogicalValueOf(IUIAutomationElement* el,BSTR value) {
  if(!value)return {};
  const size_t size=SysStringLen(value);
  if(size>4097)return "[oversize]";
  std::wstring observed(value,size),logical=observed;
  UIA_HWND native_window=0;int process_id=0;
  if(size&&value[size-1]==L'\r'&&SUCCEEDED(el->get_CurrentNativeWindowHandle(&native_window))&&native_window&&
      SUCCEEDED(el->get_CurrentProcessId(&process_id))){
    HWND hwnd=reinterpret_cast<HWND>(native_window);DWORD native_pid=0;GetWindowThreadProcessId(hwnd,&native_pid);
    wchar_t class_name[64]{};
    const bool rich=native_pid==static_cast<DWORD>(process_id)&&GetClassNameW(hwnd,class_name,64)&&
      (!_wcsicmp(class_name,L"RICHEDIT50W")||!_wcsicmp(class_name,L"RichEdit20W")||!_wcsicmp(class_name,L"RichEdit20A")||!_wcsicmp(class_name,L"RICHEDIT"));
    if(rich){
      wchar_t text[4098]{};DWORD_PTR count=0;
      if(SendMessageTimeoutW(hwnd,WM_GETTEXT,4098,reinterpret_cast<LPARAM>(text),SMTO_ABORTIFHUNG|SMTO_BLOCK,50,&count)&&count<4098)
        logical=LogicalValueText(observed,std::wstring(text,static_cast<size_t>(count)),true);
    }
  }
  if(logical.size()>4096)return "[oversize]";
  BSTR result=SysAllocStringLen(logical.data(),static_cast<UINT>(logical.size()));
  if(!result)return "[oversize]";
  const auto out=ToUtf8(result);SysFreeString(result);return out;
}

std::string ValueOf(IUIAutomationElement* el) {
  ComPtr<IUIAutomationValuePattern> vp;
  if (FAILED(el->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(vp.GetAddressOf()))) || !vp)
    return std::string();
  BSTR b = nullptr;
  std::string out;
  if (SUCCEEDED(vp->get_CurrentValue(&b)) && b) out = LogicalValueOf(el,b);
  if (b) SysFreeString(b);
  return out;
}

template <class T>
bool PatternOf(IUIAutomationElement* el, PATTERNID id, ComPtr<T>& out) {
  out.Reset();
  IUnknown* raw = nullptr;
  if (FAILED(el->GetCurrentPattern(id, &raw)) || !raw) return false;
  ComPtr<IUnknown> unk;
  unk.Attach(raw);
  if (FAILED(unk.As(&out))) {
    out.Reset();
    return false;
  }
  return true;
}

void Walk(Impl* im, SessionState* ss, IUIAutomationTreeWalker& w, IUIAutomationElement* el, int depth,
          std::vector<ElemInfo>& out, bool& truncated, int& visited, bool nonclient_menu=false) {
  if (++visited > kMaxTreeNodes || depth > 48) {
    truncated = true;
    return;
  }
  ElemInfo e;
  int ct = 0;
  BOOL password = FALSE, enabled = 0;
  int process_id = 0;
  const std::string runtime = IdentityOf(el);
  auto prior = ss->previous_identities.find(runtime);
  BOOL same = FALSE;
  if (prior != ss->previous_identities.end() &&
      SUCCEEDED(im->uia->CompareElements(prior->second.element.Get(), el, &same)) && same)
    e.identity = prior->second.token;
  else
    e.identity = NewOpaqueHandle();
  if (e.identity.empty()) { truncated = true; return; }
  ss->identities[runtime] = {el, e.identity};
  const HRESULT type_hr = el->get_CurrentControlType(&ct);
  const HRESULT enabled_hr = el->get_CurrentIsEnabled(&enabled);
  const HRESULT password_hr = el->get_CurrentIsPassword(&password);
  const HRESULT pid_hr = el->get_CurrentProcessId(&process_id);
  if (FAILED(pid_hr) || static_cast<DWORD>(process_id) != ss->pid) return;
  e.role = RoleName(ct);
  const bool name_ok = TryTextOf(el, &IUIAutomationElement::get_CurrentName, e.name);
  const bool id_ok = TryTextOf(el, &IUIAutomationElement::get_CurrentAutomationId, e.automation_id);
  // Win32's non-client system-menu proxy recreates its virtual menu item on
  // every read. It is window chrome, not an application control. Keep counting
  // and traversing its raw nodes, but issue no actionable/public handles for
  // that exact branch; otherwise an unchanged form is permanently stale.
  const bool system_menu=nonclient_menu||(SUCCEEDED(type_hr)&&id_ok&&ct==UIA_MenuBarControlTypeId&&e.automation_id=="SystemMenuBar");
  e.enabled = SUCCEEDED(enabled_hr) && enabled != 0;
  e.is_password = password != 0;
  e.sensitive = !name_ok || !id_ok || FAILED(type_hr) || FAILED(enabled_hr) || FAILED(password_hr) || e.is_password ||
                 e.name == "[oversize]" || e.automation_id == "[oversize]" ||
                 IsSensitiveText(e.name) || IsSensitiveText(e.automation_id);
  if (!e.is_password && !e.sensitive) {
    e.value = ValueOf(el);
    if (e.value == "[oversize]" || IsSensitiveText(e.value)) e.sensitive = true;
  }
  ComPtr<IUIAutomationTogglePattern> tg;
  if (PatternOf(el, UIA_TogglePatternId, tg)) {
    ToggleState st = ToggleState_Indeterminate;
    if (SUCCEEDED(tg->get_CurrentToggleState(&st))) {
      if (st != ToggleState_Indeterminate) {
        e.has_checked = true;
        e.checked = st == ToggleState_On;
      }
    }
  }
  ComPtr<IUIAutomationSelectionItemPattern> si;
  if (PatternOf(el, UIA_SelectionItemPatternId, si)) {
    BOOL sel = FALSE;
    if (SUCCEEDED(si->get_CurrentIsSelected(&sel))) {
      e.has_selected = true;
      e.selected = sel != 0;
    }
  }
  if(!system_menu){ss->by_identity[e.identity] = el;out.push_back(std::move(e));}

  IUIAutomationElement* child = nullptr;
  const HRESULT first_hr = w.GetFirstChildElement(el, &child);
  if (FAILED(first_hr)) { truncated = true; return; }
  if (child) {
    while (child) {
      Walk(im, ss, w, child, depth + 1, out, truncated, visited, system_menu);
      IUIAutomationElement* next = nullptr;
      const HRESULT next_hr = w.GetNextSiblingElement(child, &next);
      const bool more = SUCCEEDED(next_hr) && next;
      if (FAILED(next_hr)) truncated = true;
      child->Release();
      child = more ? next : nullptr;
      if (truncated) {
        if (child) child->Release();
        return;
      }
    }
  }
}

Status VerifyUniqueLiveElement(Impl* im, SessionState* ss, IUIAutomationElement* target, const std::string& automation_id,
                               const std::string& expected_role) {
  ComPtr<IUIAutomationTreeWalker> walker;
  if (FAILED(im->uia->get_RawViewWalker(&walker)) || !walker)
    return Status::Fail("E_UIA_INIT", "cannot create a raw-view walker");
  std::deque<ComPtr<IUIAutomationElement>> pending;
  pending.push_back(ss->root);
  int visited = 0, matches = 0;
  bool exact = false;
  while (!pending.empty()) {
    if (++visited > kMaxTreeNodes)
      return Status::Fail("E_STALE_ELEMENT", "bounded tree scan cannot establish unique element identity");
    ComPtr<IUIAutomationElement> current = pending.front();
    pending.pop_front();
    int process_id = 0;
    if (FAILED(current->get_CurrentProcessId(&process_id)))
      return Status::Fail("E_UIA_READ_FAILED", "cannot verify element process identity");
    if (static_cast<DWORD>(process_id) != ss->pid) continue;
    BSTR raw_id = nullptr;
    const HRESULT id_hr = current->get_CurrentAutomationId(&raw_id);
    const std::string current_id = ToUtf8(raw_id);
    if (raw_id) SysFreeString(raw_id);
    if (FAILED(id_hr) || current_id == "[oversize]")
      return Status::Fail("E_UIA_READ_FAILED", "cannot establish all control identities");
    int current_type = 0;
    if (FAILED(current->get_CurrentControlType(&current_type)))
      return Status::Fail("E_UIA_READ_FAILED", "cannot establish all control types");
    if (current_id == automation_id && RoleName(current_type) == expected_role) {
      BOOL same = FALSE;
      if (FAILED(im->uia->CompareElements(target, current.Get(), &same)))
        return Status::Fail("E_UIA_READ_FAILED", "cannot compare the retained control");
      // Broad permissions and the vocabulary tiers use the retained UIA identity, so anonymous
      // or repeated AutomationIds do not prevent input to one exactly observed control.
      if (!(im->allow_all || im->tier) || same) ++matches;
      if (same) exact = true;
    }
    ComPtr<IUIAutomationElement> child;
    if (FAILED(walker->GetFirstChildElement(current.Get(), child.GetAddressOf())))
      return Status::Fail("E_UIA_READ_FAILED", "cannot establish the full control tree");
    if (child) {
      while (child) {
        if (visited + static_cast<int>(pending.size()) >= kMaxTreeNodes)
          return Status::Fail("E_STALE_ELEMENT", "bounded tree scan cannot establish unique element identity");
        pending.push_back(child);
        ComPtr<IUIAutomationElement> next;
        if (FAILED(walker->GetNextSiblingElement(child.Get(), next.GetAddressOf())))
          return Status::Fail("E_UIA_READ_FAILED", "cannot establish the full control tree");
        child = next;
      }
    }
  }
  if (matches != 1 || !exact)
    return Status::Fail("E_STALE_ELEMENT", "element is stale or its AutomationId is not unique");
  return Status::Ok();
}

Status Probe(void* ctx, Session& s, FocusProbe& out) {
  Impl* im = reinterpret_cast<Impl*>(ctx);
  if(im->lifecycle_enabled)return im->human_probe->Sample(out);
  const HWND fg = GetForegroundWindow();
  if (!fg) return Status::Fail("E_FOCUS_PROBE", "cannot sample the foreground window");
  out.foreground = (unsigned long long)(uintptr_t)fg;
  POINT p = {};
  if (!GetCursorPos(&p)) return Status::Fail("E_FOCUS_PROBE", "cannot sample the cursor position");
  out.cursor_x = p.x;
  out.cursor_y = p.y;
  ComPtr<IUIAutomationElement> fe;
  if (FAILED(im->uia->GetFocusedElement(&fe)) || !fe)
    return Status::Fail("E_FOCUS_PROBE", "cannot sample the focused UI Automation element");
  SAFEARRAY* runtime = nullptr;
  const HRESULT runtime_status = fe->GetRuntimeId(&runtime);
  const bool valid_runtime = SUCCEEDED(runtime_status) && FocusRuntimeIdentity(runtime, out.focus_identity);
  if (runtime) SafeArrayDestroy(runtime);
  if (!valid_runtime)
    return Status::Fail("E_FOCUS_PROBE", "cannot establish a complete focused element identity");
  GUITHREADINFO gi = {};
  gi.cbSize = sizeof gi;
  const DWORD tid = GetWindowThreadProcessId(fg, nullptr);
  if (tid == 0 || !GetGUIThreadInfo(tid, &gi))
    return Status::Fail("E_FOCUS_PROBE", "cannot sample the focused native window");
  out.focus_identity += "|g:" + Hex(gi.hwndFocus);
  (void)s;
  return Status::Ok();
}

struct MonitorEnum {
  RECT window;
  unsigned ordinal = 0;
  std::vector<std::string>* ids;
};

BOOL CALLBACK AddIntersectingMonitor(HMONITOR mon, HDC, LPRECT, LPARAM lp) {
  MonitorEnum* me = reinterpret_cast<MonitorEnum*>(lp);
  MONITORINFO mi = {};
  mi.cbSize = sizeof mi;
  if (!GetMonitorInfoW(mon, &mi)) return FALSE;  // fail safe: stop, caller errors out
  const auto ordinal=me->ordinal++;
  const RECT& m = mi.rcMonitor;
  if (m.left < me->window.right && me->window.left < m.right &&
      m.top < me->window.bottom && me->window.top < m.bottom)
    me->ids->push_back("display_" + std::to_string(ordinal));  // session-local display pseudonym
  return TRUE;
}

// Ensures a retained entry exists for (hwnd, process start) and its root
// element still compares equal; retires and rebuilds the entry otherwise.
Status RefreshRetained(Impl* im, HWND hwnd, RetainedTarget** out) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (!IsWindow(hwnd) || pid == 0)
    return Status::Fail("E_TARGET_NOT_FOUND", "candidate window closed");
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!h) return Status::Fail("E_TARGET_NOT_FOUND", "cannot open the target process identity");
  unsigned long long start = 0;
  const std::wstring exe = ExePathFromHandle(h);
  if (!ProcessStartHandle(h, start) || exe.empty() ||
      ((!im->allow_all || im->restrict_targets) && exe != im->want_path)) {
    CloseHandle(h);
    return Status::Fail("E_TARGET_NOT_FOUND", "target process identity could not be verified");
  }
  const auto key = std::make_pair((unsigned long long)(uintptr_t)hwnd, start);
  auto it = im->targets.find(key);
  if (it != im->targets.end()) {
    ComPtr<IUIAutomationElement> current;
    BOOL same = FALSE;
    if (it->second.destroyed && !it->second.destroyed->load() && !it->second.exe_path.empty() &&
        it->second.exe_path == exe &&
        SUCCEEDED(im->uia->ElementFromHandle(hwnd, &current)) && current &&
        SUCCEEDED(im->uia->CompareElements(it->second.root.Get(), current.Get(), &same)) && same) {
      CloseHandle(h);  // the retained entry already owns a handle for this process
      *out = &it->second;
      return Status::Ok();
    }
    if(it->second.destroyed)it->second.destroyed->store(true);
    CloseHandle(it->second.process);  // root changed: retire forever, rebuild below
    im->targets.erase(it);
  }
  ComPtr<IUIAutomationElement> root;
  if (FAILED(im->uia->ElementFromHandle(hwnd, &root)) || !root) {
    CloseHandle(h);
    return Status::Fail("E_TARGET_NOT_FOUND", "cannot resolve the target root element");
  }
  RetainedTarget entry;
  entry.hwnd = hwnd;
  entry.pid = pid;
  entry.process = h;
  entry.start = start;
  entry.exe_path = exe;
  entry.root = root;
  entry.destroyed = im->lifetime.Watch(hwnd);
  if (!entry.destroyed) {CloseHandle(h);return Status::Fail("E_RESOURCE_LIMIT", "window lifetime watch limit");}
  entry.root_token = "r-" + NewOpaqueHandle();
  if (entry.root_token.size() <= 2) {
    CloseHandle(h);
    return Status::Fail("E_INTERNAL", "could not allocate an opaque root token");
  }
  auto placed = im->targets.emplace(key, std::move(entry));
  *out = &placed.first->second;
  return Status::Ok();
}

// Drops retained entries whose window is gone or no longer owned by the same
// process; their target ids leave the registry on the next synchronize.
void PruneRetained(Impl* im, const std::vector<HWND>& live) {
  for (auto it = im->targets.begin(); it != im->targets.end();) {
    const HWND hwnd = it->second.hwnd;
    bool seen = false;
    for (HWND h : live)
      if (h == hwnd) { seen = true; break; }
    DWORD pid = 0;
    if (seen) {
      GetWindowThreadProcessId(hwnd, &pid);
      seen = IsWindow(hwnd) != FALSE && pid == it->second.pid;
    }
    if (seen) { ++it; continue; }
    if(it->second.destroyed)it->second.destroyed->store(true);
    if (it->second.process) CloseHandle(it->second.process);
    it = im->targets.erase(it);
  }
}

Status EnumerateTargets(void* ctx, std::vector<TargetObservation>& out, std::string& out_app_id) {
  Impl* im = reinterpret_cast<Impl*>(ctx);
  out.clear();
  Status init = EnsureUia(im);  // verifies AutoSetFocus is off before anything is claimed
  if (!init.ok()) return init;
  EnumContext ec;
  ec.want_path = &im->want_path;
  ec.allow_all = im->allow_all&&!im->restrict_targets;
  out_app_id=im->app_id;
  if(im->lifecycle_enabled){
    if(!im->owned_process||WaitForSingleObject(im->owned_process,0)!=WAIT_TIMEOUT){PruneRetained(im,{});return Status::Ok();}
    ec.only_pid=im->owned_pid;
  }
  const BOOL enumerated=EnumWindows(CollectCandidates, (LPARAM)&ec);
  if (im->allow_all && ec.hwnds.size() > kMaxTargets) ec.hwnds.resize(kMaxTargets);
  if (ec.hwnds.size() > kMaxTargets)
    return Status::Fail("E_TARGET_LIMIT", "more than 32 candidate windows; refusing to guess");
  if (!enumerated) return Status::Fail("E_TARGET_NOT_FOUND", "window enumeration failed");
  PruneRetained(im, ec.hwnds);
  for (HWND hwnd : ec.hwnds) {
    RetainedTarget* rt = nullptr;
    Status st = RefreshRetained(im, hwnd, &rt);
    if (!st.ok()) { if(im->allow_all)continue;return st; }
    TargetObservation o;
    o.window_key = (unsigned long long)(uintptr_t)hwnd;
    o.process_start = rt->start;
    o.root_token = rt->root_token;
    wchar_t title[512] = {};
    const int n = GetWindowTextW(hwnd, title, 512);
    if (n > 0) {
      std::string label;
      const int w = WideCharToMultiByte(CP_UTF8, 0, title, n, nullptr, 0, nullptr, nullptr);
      if (w > 0) {
        label.assign(static_cast<size_t>(w), '\0');
        WideCharToMultiByte(CP_UTF8, 0, title, n, &label[0], w, nullptr, nullptr);
      }
      o.label = label;
    }
    RECT r = {};
    if (!GetWindowRect(hwnd, &r))
      return Status::Fail("E_UIA_READ_FAILED", "cannot read the window rectangle");
    o.x = r.left; o.y = r.top; o.width = r.right - r.left; o.height = r.bottom - r.top;
    RECT ui = {};
    if (SUCCEEDED(rt->root->get_CurrentBoundingRectangle(&ui))) {
      // UIA physical rect wins when the provider reports one; both are signed
      // desktop physical pixels under per-monitor v2 awareness.
      if (ui.right > ui.left && ui.bottom > ui.top) {
        o.x = ui.left; o.y = ui.top; o.width = ui.right - ui.left; o.height = ui.bottom - ui.top;
      }
    }
    o.minimized = IsIconic(hwnd) != FALSE;
    MonitorEnum me;
    me.window = {static_cast<LONG>(o.x), static_cast<LONG>(o.y),
                 static_cast<LONG>(o.x + o.width), static_cast<LONG>(o.y + o.height)};
    me.ids = &o.display_ids;
    if (!EnumDisplayMonitors(nullptr, nullptr, AddIntersectingMonitor, (LPARAM)&me))
      return Status::Fail("E_UIA_READ_FAILED", "cannot enumerate the displays under the window");
    out.push_back(std::move(o));
  }
  out_app_id = im->app_id;
  return Status::Ok();
}

Status Discover(void* ctx, bool& available, std::string& app_id) {
  std::vector<TargetObservation> obs;
  Status st = EnumerateTargets(ctx, obs, app_id);
  available = st.ok() && !obs.empty();
  return st;
}

// Binds the exact (hwnd, process start) the broker selected from the registry.
// Never re-probes or falls back to another window.
Status Bind(void* ctx, Session& s) {
  Impl* im = reinterpret_cast<Impl*>(ctx);
  Status st = EnsureUia(im);
  if (!st.ok()) return st;
  const auto key = std::make_pair(s.hwnd, s.start_time);
  auto it = im->targets.find(key);
  if (it == im->targets.end())
    return Status::Fail("E_TARGET_NOT_FOUND", "selected target is not in the native registry");
  RetainedTarget& rt = it->second;
  if (!rt.destroyed || rt.destroyed->load() || rt.root_token != s.binding_token) return Status::Fail("E_TARGET_NOT_FOUND", "selected root generation changed");
  if (!IsWindow(rt.hwnd) || WaitForSingleObject(rt.process, 0) != WAIT_TIMEOUT)
    return Status::Fail("E_TARGET_NOT_FOUND", "selected target window is gone");
  unsigned long long start = 0;
  if (!ProcessStartHandle(rt.process, start) || start != s.start_time || rt.exe_path.empty() ||
      ExePathFromHandle(rt.process) != rt.exe_path)
    return Status::Fail("E_TARGET_NOT_FOUND", "selected target process identity changed");
  ComPtr<IUIAutomationElement> current;
  BOOL same = FALSE;
  if (FAILED(im->uia->ElementFromHandle(rt.hwnd, &current)) || !current ||
      FAILED(im->uia->CompareElements(rt.root.Get(), current.Get(), &same)) || !same)
    return Status::Fail("E_TARGET_NOT_FOUND", "selected target root element changed");
  HANDLE session_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, rt.pid);
  if (!session_handle) return Status::Fail("E_TARGET_NOT_FOUND", "cannot open the target process");
  unsigned long long session_start = 0;
  if (!ProcessStartHandle(session_handle, session_start) || session_start != s.start_time ||
      rt.exe_path.empty() || ExePathFromHandle(session_handle) != rt.exe_path) {
    CloseHandle(session_handle); return Status::Fail("E_TARGET_NOT_FOUND", "selected process generation changed");
  }
  auto* ss = new (std::nothrow) SessionState();
  if (!ss) {
    CloseHandle(session_handle);
    return Status::Fail("E_INTERNAL", "cannot allocate session state");
  }
  ss->pid = rt.pid;
  ss->process = session_handle;
  ss->exe_path = rt.exe_path;
  ss->destroyed=rt.destroyed;ss->binding_token=rt.root_token;
  if (ss->destroyed->load()) {CloseHandle(session_handle);delete ss;return Status::Fail("E_TARGET_NOT_FOUND", "window destroyed before bind");}
  ss->root = rt.root;  // ComPtr copy; the retained entry keeps its own reference
  s.pid = (unsigned long)rt.pid;
  if(s.mode=="interactive_desktop") {
    if(!im->interactive_enabled||!im->visual_enabled||im->input_leased||GetForegroundWindow()!=rt.hwnd||!im->input_monitor.Healthy()||!NoHeldInput()) {
      CloseHandle(session_handle);delete ss;return Status::Fail("E_INTERFERENCE_RISK","interactive input lease is unavailable");
    }
    ss->input_lease=std::make_unique<InputLease>();
    if(!ss->input_lease->Acquire()){CloseHandle(session_handle);delete ss;return Status::Fail("E_INTERFERENCE_RISK","another helper owns the interactive input lease");}
    ss->lease_human_sequence=im->input_monitor.Sequence();
    im->input_leased=true;
  }
  s.impl = ss;
  return Status::Ok();
}

Status Revalidate(void* ctx, Session& s) {
  Impl* im = reinterpret_cast<Impl*>(ctx);
  SessionState* ss = StateOf(s);
  if (!ss || !ss->root) return Status::Fail("E_SESSION_INVALID", "no bound root element");
  if (!ss->destroyed || ss->destroyed->load() || ss->binding_token!=s.binding_token) return Status::Fail("E_TARGET_NOT_FOUND", "window generation retired");
  if (!ss->process || WaitForSingleObject(ss->process, 0) != WAIT_TIMEOUT)
    return Status::Fail("E_TARGET_NOT_FOUND", "target process exited");
  unsigned long long start = 0;
  if (!ProcessStartHandle(ss->process, start) || start != s.start_time || ss->exe_path.empty() ||
      ExePathFromHandle(ss->process) != ss->exe_path)
    return Status::Fail("E_TARGET_NOT_FOUND", "target process identity changed");
  const HWND h = (HWND)(uintptr_t)s.hwnd;
  DWORD pid = 0;
  GetWindowThreadProcessId(h, &pid);
  if (!IsWindow(h) || pid != ss->pid)
    return Status::Fail("E_TARGET_NOT_FOUND", "target window handle no longer belongs to the process");
  if (!IsWindowVisible(h) || IsIconic(h))
    return Status::Fail("E_UNSUPPORTED_ACTION", "minimized windows cannot be observed or mutated");
  ComPtr<IUIAutomationElement> current_root;
  BOOL same = FALSE;
  if (FAILED(im->uia->ElementFromHandle(h, &current_root)) || !current_root ||
      FAILED(im->uia->CompareElements(ss->root.Get(), current_root.Get(), &same)) || !same)
    return Status::Fail("E_TARGET_NOT_FOUND", "target root automation element changed");
  return EnsureUia(im);
}

Status Snapshot(void* ctx, Session& s, SnapshotResult& out) {
  Impl* im = reinterpret_cast<Impl*>(ctx);
  SessionState* ss = StateOf(s);
  if (!ss || !ss->root) return Status::Fail("E_SESSION_INVALID", "no bound root element");
  if (!ss->destroyed || ss->destroyed->load() || ss->binding_token!=s.binding_token) return Status::Fail("E_TARGET_NOT_FOUND", "window generation retired");
  ComPtr<IUIAutomationTreeWalker> w;
  if (FAILED(im->uia->get_RawViewWalker(&w)) || !w)
    return Status::Fail("E_UIA_INIT", "cannot create a UIA tree walker");
  ss->by_identity.clear();
  ss->previous_identities = std::move(ss->identities);
  ss->identities.clear();
  bool truncated = false;
  int visited = 0;
  Walk(im, ss, *w.Get(), ss->root.Get(), 0, out.elements, truncated, visited);
  ss->previous_identities.clear();
  out.truncated = truncated || (int)out.elements.size() >= kMaxTreeNodes;
  (void)s;
  return Status::Ok();
}

// Known editable/password/sensitive native controls are always blacked out.
// Full traversal and valid geometry are mandatory; an incomplete mask is denied.
Status CaptureMasks(void* ctx, Session& s, std::vector<RECT>& masks, std::map<std::string, RECT>& identity_rects) {
  SnapshotResult snap;
  Status st=Snapshot(ctx,s,snap);
  if(!st.ok())return st;
  if(snap.truncated)return Status::Fail("E_POLICY_DENIED","cannot establish complete sensitive-control masks");
  SessionState* ss=StateOf(s);
  // Walk() intentionally skips foreign/unknown process branches for semantic
  // observation. Pixel redaction cannot treat such a branch as absent.
  Impl* im=static_cast<Impl*>(ctx);
  // Mutation permissions never disable automatic image privacy masks.
  ComPtr<IUIAutomationTreeWalker> walker;
  if(FAILED(im->uia->get_RawViewWalker(&walker))||!walker)
    return Status::Fail("E_POLICY_DENIED","cannot establish capture tree membership");
  std::deque<ComPtr<IUIAutomationElement>> pending;pending.push_back(ss->root);size_t visited=0;
  while(!pending.empty()) {
    if(++visited>static_cast<size_t>(kMaxTreeNodes))return Status::Fail("E_POLICY_DENIED","capture tree exceeds mask bound");
    auto current=pending.front();pending.pop_front();int pid=0;
    if(FAILED(current->get_CurrentProcessId(&pid))||static_cast<DWORD>(pid)!=ss->pid)
      return Status::Fail("E_POLICY_DENIED","capture tree contains unverifiable process content");
    ComPtr<IUIAutomationElement> child;
    if(FAILED(walker->GetFirstChildElement(current.Get(),&child)))return Status::Fail("E_POLICY_DENIED","capture child scan failed");
    while(child) {
      if(visited+pending.size()>=static_cast<size_t>(kMaxTreeNodes))return Status::Fail("E_POLICY_DENIED","capture tree exceeds mask bound");
      pending.push_back(child);ComPtr<IUIAutomationElement> next;
      if(FAILED(walker->GetNextSiblingElement(child.Get(),&next)))return Status::Fail("E_POLICY_DENIED","capture sibling scan failed");
      child=next;
    }
  }
  for(const auto& e:snap.elements) {
    if(e.role!="edit"&&!e.sensitive&&!e.is_password)continue;
    const auto found=ss->by_identity.find(e.identity);
    RECT rect{};
    if(found==ss->by_identity.end()||FAILED(found->second->get_CurrentBoundingRectangle(&rect))||
       rect.right<=rect.left||rect.bottom<=rect.top)
      return Status::Fail("E_POLICY_DENIED","sensitive-control geometry cannot be verified");
    masks.push_back(rect);
    identity_rects.emplace(e.identity,rect);
  }
  return Status::Ok();
}

Status IssueInputProof(Impl*,Session&,const WindowPixels&,json&);

Status Capture(void* ctx, Session& s, json& result) {
  Impl* im=static_cast<Impl*>(ctx);
  if(!im->visual_enabled)return Status::Fail("E_POLICY_DENIED","visual disclosure was not enabled at launch");
  if(s.mode=="interactive_desktop"&&(!im->input_monitor.Healthy()||im->input_monitor.Sequence()!=StateOf(s)->lease_human_sequence))
    return Status::Fail("E_INTERFERENCE_RISK","unattributed input retired this interactive lease");
  Status st=Revalidate(ctx,s);if(!st.ok())return st;
  std::vector<RECT> masks;
  std::map<std::string,RECT> before_masks,after_masks;
  st=CaptureMasks(ctx,s,masks,before_masks);if(!st.ok())return st;
  WindowPixels pixels;
  SessionState* ss=StateOf(s);
  st=ReadWindowPixels(reinterpret_cast<HWND>(static_cast<uintptr_t>(s.hwnd)),ss->destroyed,pixels);
  if(!st.ok())return st;
  st=Revalidate(ctx,s);if(!st.ok())return st;
  st=CaptureMasks(ctx,s,masks,after_masks);if(!st.ok())return st;
  if(before_masks.size()!=after_masks.size())return Status::Fail("E_STALE_STATE","sensitive-control mask set changed during capture");
  for(const auto& mask:before_masks) {
    const auto after=after_masks.find(mask.first);
    if(after==after_masks.end()||!EqualRect(&mask.second,&after->second))
      return Status::Fail("E_STALE_STATE","sensitive-control identity or geometry changed during capture");
  }
  RECT current{};
  if(FAILED(DwmGetWindowAttribute(reinterpret_cast<HWND>(static_cast<uintptr_t>(s.hwnd)),
       DWMWA_EXTENDED_FRAME_BOUNDS,&current,sizeof current))||!EqualRect(&current,&pixels.bounds))
    return Status::Fail("E_STALE_STATE","window geometry changed before redaction");
  std::string encoded;
  st=EncodeWindowPixels(pixels,masks,encoded);if(!st.ok())return st;
  st=Revalidate(ctx,s);if(!st.ok())return st;
  if(FAILED(DwmGetWindowAttribute(reinterpret_cast<HWND>(static_cast<uintptr_t>(s.hwnd)),
       DWMWA_EXTENDED_FRAME_BOUNDS,&current,sizeof current))||!EqualRect(&current,&pixels.bounds))
    return Status::Fail("E_STALE_STATE","window geometry changed during PNG encoding");
  if(ss->visual_epoch.empty()||!EqualRect(&ss->visual_bounds,&pixels.bounds)) {
    ss->visual_epoch=NewOpaqueHandle();ss->visual_bounds=pixels.bounds;
    if(ss->visual_epoch.empty())return Status::Fail("E_INTERNAL","could not allocate visual epoch");
  }
  result={{"png_base64",encoded},{"captured_at",pixels.captured_at},{"coordinate_space","window_pixels"},
    {"viewport",{{"width",pixels.width},{"height",pixels.height},{"scroll_x",0},{"scroll_y",0},{"device_scale_factor",1}}},
    {"source_to_desktop",{{"origin_x",pixels.bounds.left},{"origin_y",pixels.bounds.top},{"scale_x",1},{"scale_y",1},
      {"coordinate_space","desktop_physical_pixels"}}},{"surface_epoch",ss->visual_epoch},{"redacted",!masks.empty()}};
  if(s.mode=="interactive_desktop")return IssueInputProof(im,s,pixels,result);
  return Status::Ok();
}

#include "interactive_backend.inc"

Status ActImpl(void* ctx, Session& s, const ActionRequest& a, std::string& detail) {
  Impl* im = reinterpret_cast<Impl*>(ctx);
  SessionState* ss = StateOf(s);
  if (!ss) return Status::Fail("E_SESSION_INVALID", "no bound session state");
  auto it = ss->by_identity.find(a.identity);
  if (it == ss->by_identity.end() || !it->second)
    return Status::Fail("E_STALE_ELEMENT", "element is no longer known in this session");
  ComPtr<IUIAutomationElement> el = it->second;
  BOOL enabled = FALSE, password = FALSE;
  int process_id = 0;
  if (FAILED(el->get_CurrentIsEnabled(&enabled)) || FAILED(el->get_CurrentIsPassword(&password)))
    return Status::Fail("E_UIA_READ_FAILED", "cannot revalidate control safety properties");
  if (FAILED(el->get_CurrentProcessId(&process_id)) || static_cast<DWORD>(process_id) != ss->pid)
    return Status::Fail("E_TARGET_MISMATCH", "element belongs to a different process");
  if (!im->allow_all && password) return Status::Fail("E_CONTROL_BLOCKED", "password controls are never mutated");
  if (!enabled) return Status::Fail("E_NOT_ENABLED", "control is not enabled");
  std::string aid;
  if (!TryTextOf(el.Get(), &IUIAutomationElement::get_CurrentAutomationId, aid))
    return Status::Fail("E_UIA_READ_FAILED", "cannot verify the control identity");
  if (aid != a.automation_id)
    return Status::Fail("E_STALE_ELEMENT", "element AutomationId no longer matches the handle");
  ElemInfo live;
  int control_type = 0;
  if (FAILED(el->get_CurrentControlType(&control_type)))
    return Status::Fail("E_UIA_READ_FAILED", "cannot verify the control type");
  live.automation_id = aid;
  if (!TryTextOf(el.Get(), &IUIAutomationElement::get_CurrentName, live.name))
    return Status::Fail("E_UIA_READ_FAILED", "cannot verify the control name");
  live.role = RoleName(control_type);
  live.is_password = password != FALSE;
  live.sensitive = live.is_password || IsSensitiveText(live.name) || IsSensitiveText(aid);
  if (im->tier && !im->allow_all) {
    // Live re-check of the tier gates against the current provider values, never the snapshot alone.
    if (live.sensitive) return Status::Fail("E_PRIVACY_BLOCKED", "sensitive control");
    if (a.action != "scroll" && !a.approved && (IsConsequentialText(live.name) || IsConsequentialText(aid)))
      return Status::Fail("E_APPROVAL_REQUIRED", "consequential control requires the one-shot host approval");
  } else if (!im->allow_all && (IsBlockedControl(live) || live.sensitive))
    return Status::Fail("E_CONTROL_BLOCKED", "control is sensitive or consequential");
  Status identity_status = VerifyUniqueLiveElement(im, ss, el.Get(), aid, a.expected_role);
  if (!identity_status.ok()) return identity_status;
  Status bound=Revalidate(ctx,s);if(!bound.ok())return bound;
  if (a.action == "fill") {
    ComPtr<IUIAutomationValuePattern> vp;
    if (!PatternOf(el.Get(), UIA_ValuePatternId, vp))
      return Status::Fail("E_PATTERN_UNSUPPORTED", "no ValuePattern on this control");
    BOOL ro = FALSE;
    if (FAILED(vp->get_CurrentIsReadOnly(&ro)))
      return Status::Fail("E_UIA_READ_FAILED", "cannot verify ValuePattern mutability");
    if (ro) return Status::Fail("E_READ_ONLY", "ValuePattern is read-only");
    const std::wstring wvalue = ToWide(a.value);
    BSTR value = SysAllocStringLen(wvalue.data(), static_cast<UINT>(wvalue.size()));
    if (!value) return Status::Fail("E_ACTION_FAILED", "could not allocate a value for SetValue");
    const HRESULT set_hr = vp->SetValue(value);
    SysFreeString(value);
    if (FAILED(set_hr))
      return Status::Fail("E_ACTION_FAILED", "ValuePattern.SetValue failed", true);
    BSTR readback = nullptr;
    const HRESULT read_hr = vp->get_CurrentValue(&readback);
    const std::string actual = LogicalValueOf(el.Get(),readback);
    if (readback) SysFreeString(readback);
    if (FAILED(read_hr) || actual != a.value)
      return Status::Fail("E_ACTION_FAILED", "ValuePattern readback did not match", true);
    detail = "value set";
  } else if (a.action == "click") {
    ComPtr<IUIAutomationInvokePattern> ip;
    if (!PatternOf(el.Get(), UIA_InvokePatternId, ip))
      return Status::Fail("E_PATTERN_UNSUPPORTED", "no InvokePattern on this control");
    if (FAILED(ip->Invoke())) return Status::Fail("E_ACTION_FAILED", "InvokePattern.Invoke failed", true);
    detail = "invoked";
  } else if (a.action == "check") {
    ComPtr<IUIAutomationTogglePattern> tp;
    if (!PatternOf(el.Get(), UIA_TogglePatternId, tp))
      return Status::Fail("E_PATTERN_UNSUPPORTED", "no TogglePattern on this control");
    ToggleState want = a.checked ? ToggleState_On : ToggleState_Off;
    ToggleState now = ToggleState_Indeterminate;
    if (FAILED(tp->get_CurrentToggleState(&now)))
      return Status::Fail("E_ACTION_FAILED", "cannot read the toggle state");
    if (now == ToggleState_Indeterminate)
      return Status::Fail("E_TOGGLE_INDETERMINATE", "indeterminate toggle state is not mutated");
    if (now == want) {
      detail = "already in the requested state";
    } else if (FAILED(tp->Toggle())) {
      return Status::Fail("E_ACTION_FAILED", "TogglePattern.Toggle failed", true);
    } else {
      ToggleState after = ToggleState_Indeterminate;
      if (FAILED(tp->get_CurrentToggleState(&after)))
        return Status::Fail("E_ACTION_FAILED", "cannot verify the toggle result", true);
      if (after != want) return Status::Fail("E_ACTION_FAILED", "toggle state did not change", true);
      detail = "toggled";
    }
  } else if (a.action == "select") {
    ComPtr<IUIAutomationSelectionItemPattern> sp;
    if (!PatternOf(el.Get(), UIA_SelectionItemPatternId, sp))
      return Status::Fail("E_PATTERN_UNSUPPORTED", "no SelectionItemPattern on this control");
    if (FAILED(sp->Select())) return Status::Fail("E_ACTION_FAILED", "SelectionItemPattern.Select failed", true);
    BOOL selected = FALSE;
    if (FAILED(sp->get_CurrentIsSelected(&selected)) || !selected)
      return Status::Fail("E_ACTION_FAILED", "SelectionItemPattern readback did not match", true);
    detail = "selected";
  } else {
    ComPtr<IUIAutomationScrollPattern> sp;
    if (!PatternOf(el.Get(), UIA_ScrollPatternId, sp))
      return Status::Fail("E_PATTERN_UNSUPPORTED", "no ScrollPattern on this control");
    if (FAILED(sp->Scroll(ScrollAmount_NoAmount,
                          a.direction == "down" ? ScrollAmount_SmallIncrement : ScrollAmount_SmallDecrement)))
      return Status::Fail("E_ACTION_FAILED", "ScrollPattern.Scroll failed", true);
    detail = "scrolled";
  }
  (void)s;
  return Status::Ok();
}

Status Act(void* ctx, Session& s, const ActionRequest& a, std::string& detail) {
  Status before=Revalidate(ctx,s);if(!before.ok())return before;
  Status result=ActImpl(ctx,s,a,detail);
  if(result.ok() || result.may_have_executed){Status after=Revalidate(ctx,s);if(!after.ok())return Status::Fail(after.code,after.message,true);}
  return result;
}

void CloseSession(void* ctx, Session& s) {
  Impl* im=static_cast<Impl*>(ctx);
  SessionState* ss = StateOf(s);
  if (!ss) return;
  ss->root.Reset();
  ss->by_identity.clear();
  ss->identities.clear();
  ss->previous_identities.clear();
  if (ss->process) CloseHandle(ss->process);
  if(ss->input_lease){ss->input_lease.reset();im->input_leased=false;}
  delete ss;
  s.impl = nullptr;
}

}  // namespace

#include "application_lifecycle.inc"

void* CreateBackendImpl(const LaunchConfig& cfg) {
  const std::wstring canon = CanonicalPath(ToWide(cfg.app_path));
  if (canon.empty()) return nullptr;
  Impl* im = new Impl();
  im->app_id = cfg.app_id;
  im->lifecycle_enabled=cfg.lifecycle_enabled;
  im->allow_all=cfg.allow_all;
  im->restrict_targets=cfg.restrict_targets;
  im->tier=cfg.operation_mode=="standard"||cfg.operation_mode=="ask";
  im->visual_enabled = cfg.visual_enabled&&!cfg.lifecycle_enabled;
  if(cfg.input_cancelled)im->input_cancelled=cfg.input_cancelled;
  if(!ParseInteractiveConfig(cfg.interactive_config,im->input_surfaces,im->interactive_enabled)||
     (im->interactive_enabled&&(!im->visual_enabled||!im->input_monitor.Start()))){delete im;return nullptr;}
  im->want_path = canon;
  if(cfg.lifecycle_enabled){
    if(!OnLifecycleDesktop()||im->interactive_enabled){delete im;return nullptr;}
    im->human_probe=std::make_unique<HumanFocusProbe>();
    if(!im->human_probe->Start()){delete im;return nullptr;}
  }
  if(!im->lifetime.Start()){delete im;return nullptr;}
  return im;
}

void DestroyBackendImpl(void* impl) {
  Impl* im = reinterpret_cast<Impl*>(impl);
  if (!im) return;
  im->lifetime.Stop();
  for (auto& entry : im->targets)
    if (entry.second.process) CloseHandle(entry.second.process);
  im->targets.clear();
  im->uia.Reset();
  im->app.Reset();
  if(im->owned_process)CloseHandle(im->owned_process);
  delete im;
}

Backend MakeWindowsBackend(void* impl) {
  Backend b;
  b.ctx = impl;
  b.discover = Discover;
  b.bind = Bind;
  b.revalidate = Revalidate;
  b.snapshot = Snapshot;
  b.act = Act;
  b.probe = Probe;
  b.close = CloseSession;
  b.enumerate_targets = EnumerateTargets;
  Impl* im=static_cast<Impl*>(impl);
  if(im->lifecycle_enabled)b.application=Application;
  if(im->visual_enabled)b.capture=Capture;
  if(im->interactive_enabled){b.input_operation=InputOperation;
    for(const auto& surface:im->input_surfaces){if(surface.drag&&std::find(b.gesture_backends.begin(),b.gesture_backends.end(),"mouse_drag")==b.gesture_backends.end())b.gesture_backends.push_back("mouse_drag");
      if(surface.swipe&&surface.swipe_backend=="scroll"&&std::find(b.gesture_backends.begin(),b.gesture_backends.end(),"scroll_swipe")==b.gesture_backends.end())b.gesture_backends.push_back("scroll_swipe");}}
  return b;
}

}  // namespace adl
