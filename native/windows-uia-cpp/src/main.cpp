// AgentDeskLink Windows native UIA helper: newline-delimited JSON server.
#if !defined(_WIN32) && !defined(ADL_SYNTAX_CHECK)
#error "windows-uia-cpp builds only for Windows with MSVC and the Windows SDK"
#endif

#include <windows.h>
#include <objbase.h>

#include <algorithm>
#include <cctype>
#include <fstream>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <string>

#include "protocol.h"
#include "uia_backend.h"
#include "request_reader.h"
#include "input_monitor.h"
#include "lifecycle_desktop.h"

namespace {

using adl::Backend;
using adl::Broker;
using adl::ControlsTable;
using adl::json;
using adl::LaunchConfig;

std::string Fail(const std::string& code, const std::string& msg) {
  return json{{"ok", false},
              {"request_id", ""},
              {"error", {{"code", code}, {"message", msg}}}}
      .dump();
}

bool Absolute(const std::string& p) {
  return p.size() >= 3 && ((isalpha((unsigned char)p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/')) ||
                           (p[0] == '\\' && p[1] == '\\'));
}

bool NextArg(int argc, char** argv, int& i, std::string& out) {
  if (i + 1 >= argc) return false;
  out = argv[++i];
  return true;
}

// Reads one line, never buffering more than cap bytes.
bool ReadLineBounded(std::istream& in, std::string& line, size_t cap, bool& too_long) {
  line.clear();
  too_long = false;
  bool any = false;
  int ch;
  while ((ch = in.get()) != std::istream::traits_type::eof()) {
    any = true;
    if (ch == '\n') break;
    if (line.size() < cap) {
      line.push_back((char)ch);
    } else {
      too_long = true;  // keep draining to the newline so framing survives
    }
  }
  return any || !in.fail();
}

std::string ReadWholeFile(const std::string& path, std::string& err, size_t cap) {
  std::ifstream f(std::filesystem::u8path(path), std::ios::binary);
  if (!f) {
    err = "cannot open controls file";
    return std::string();
  }
  std::string body;
  body.reserve(std::min<size_t>(cap, 4096));
  char buf[4096];
  while (f) {
    f.read(buf, sizeof(buf));
    const size_t n = static_cast<size_t>(f.gcount());
    if (body.size() + n > cap) { err = "controls file larger than 64 KiB"; return std::string(); }
    body.append(buf, n);
  }
  return body;
}

// Window geometry is reported in desktop physical pixels, so the process must
// be per-monitor DPI aware v2 before any window or UIA handle is touched.
bool MakePerMonitorAwareV2() {
  const HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (!user32) return false;
  using SetContextFn = BOOL(WINAPI *)(HANDLE);
  const auto set_context =
      reinterpret_cast<SetContextFn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
  if (!set_context) return false;
  if (set_context(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return true;
  return AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != FALSE;
}

}  // namespace

int Run(int argc, char** argv) {
  if(argc==2&&std::string(argv[1])=="--release-input") {
    adl::InputLease lease;const bool released=lease.Acquire(true)&&adl::EmergencyReleaseOwned(lease);
    std::cout<<json{{"released_input",released}}.dump()<<std::endl;return released?0:2;
  }
  std::atomic<bool> input_cancelled{false};
  if (!MakePerMonitorAwareV2()) {
    std::cout << Fail("E_CONFIG", "SetProcessDpiAwarenessContext per-monitor v2 is unavailable")
              << std::endl;
    return 2;
  }
  LaunchConfig cfg;cfg.input_cancelled=&input_cancelled;
  std::string controls_file,interactive_json;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--app-id") {
      if (!NextArg(argc, argv, i, cfg.app_id)) return 2;
    } else if (a == "--app-path") {
      if (!NextArg(argc, argv, i, cfg.app_path)) return 2;
    } else if (a == "--visual-enabled") {
      cfg.visual_enabled = true;
    } else if (a == "--lifecycle-enabled") {
      cfg.lifecycle_enabled = true;
    } else if (a == "--allow-all") {
      cfg.allow_all = true;
    } else if (a == "--restrict-targets") {
      cfg.restrict_targets = true;
    } else if (a == "--lifecycle-worker") {
      // Verified against the actual non-input desktop in wmain, before COM.
    } else if (a == "--interactive-config") {
      if (!NextArg(argc,argv,i,interactive_json))return 2;
    } else if (a == "--controls-file") {
      if (!NextArg(argc, argv, i, controls_file)) return 2;
    } else {
      std::cout << Fail("E_CONFIG", "unknown argument") << std::endl;
      return 2;
    }
  }
  if (cfg.app_id.empty() || cfg.app_id.size() > 128) {
    std::cout << Fail("E_CONFIG", "--app-id is required") << std::endl;
    return 2;
  }
  if (!Absolute(cfg.app_path) || (!controls_file.empty() && !Absolute(controls_file))) {
    std::cout << Fail("E_CONFIG", "--app-path and --controls-file must be absolute paths") << std::endl;
    return 2;
  }
  std::string err;
  const std::string body = controls_file.empty() ? "{}" : ReadWholeFile(controls_file, err, (size_t)adl::kMaxLineBytes);
  if (body.empty()) {
    std::cout << Fail("E_CONFIG", err) << std::endl;
    return 2;
  }
  json doc;
  try {
    doc = json::parse(body);
  } catch (const std::exception&) {
    std::cout << Fail("E_CONFIG", "controls file is not valid JSON") << std::endl;
    return 2;
  }
  ControlsTable controls;
  if (!adl::LoadControls(doc, controls, err)) {
    std::cout << Fail("E_CONFIG", err) << std::endl;
    return 2;
  }
  controls.allow_all = cfg.allow_all;

  if(!interactive_json.empty()) {
    if(interactive_json.size()>8192){std::cout<<Fail("E_CONFIG","interactive configuration exceeds bounded inline JSON")<<std::endl;return 2;}
    try{cfg.interactive_config=json::parse(interactive_json);}catch(...){std::cout<<Fail("E_CONFIG","invalid interactive configuration")<<std::endl;return 2;}
  }
  if(cfg.lifecycle_enabled&&cfg.interactive_config.value("enabled",false)){
    std::cout<<Fail("E_CONFIG","lifecycle isolation cannot share physical input")<<std::endl;return 2;
  }

  const HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    std::cout << Fail("E_UIA_INIT", "CoInitializeEx failed") << std::endl;
    return 2;
  }

  void* impl = adl::CreateBackendImpl(cfg);
  if (!impl) {
    std::cout << Fail("E_CONFIG", "configured executable path could not be canonicalized") << std::endl;
    CoUninitialize();
    return 2;
  }
  const Backend backend = adl::MakeWindowsBackend(impl);
  Broker broker;  // discover and open route through its target registry

  std::cout << std::unitbuf;
  {
    adl::RequestReader reader(std::cin,input_cancelled);
    adl::RequestReader::Request request;
    while(reader.Next(request)) {
      if(request.line.empty()){reader.Finished();continue;}
      bool shutdown=false;std::string out;
      if(request.too_long)out=Fail("E_INPUT_TOO_LARGE","request line exceeds 64 KiB");
      else try{out=adl::HandleRequest(request.line,broker,backend,controls,shutdown);}
      catch(...){out=Fail("E_INTERNAL","request failed safely");shutdown=true;}
      if(out.size()>static_cast<size_t>(adl::kMaxResponseBytes))out=Fail("E_OUTPUT_TOO_LARGE","response exceeds bounded transport");
      std::cout<<out<<'\n'<<std::flush;reader.Finished();if(shutdown)break;
    }
  }

  broker.CloseAll(backend);  // EOF or shutdown releases every session, then the registry
  adl::DestroyBackendImpl(impl);
  CoUninitialize();
  return 0;
}

// Windows passes Unicode paths via UTF-16. Convert once, without the current
// console codepage, before applying the UTF-8 JSON protocol/config contract.
int wmain(int argc, wchar_t** argv) {
  int lifecycle=0,worker=0;
  for(int i=1;i<argc;++i){
    const std::wstring option=argv[i];
    // A configured ID/path/JSON value is data even when it resembles a flag.
    if(option==L"--app-id"||option==L"--app-path"||option==L"--controls-file"||option==L"--interactive-config"){if(i+1<argc)++i;continue;}
    if(option==L"--lifecycle-enabled")++lifecycle;if(option==L"--lifecycle-worker")++worker;
  }
  if(lifecycle>1||worker>1||(worker&&(!lifecycle||!adl::OnLifecycleDesktop()))){std::cout<<Fail("E_CONFIG","invalid isolated lifecycle worker")<<std::endl;return 2;}
  if(lifecycle&&!worker){int code=2;if(!adl::RunLifecycleWorker(argc,argv,code)){std::cout<<Fail("E_BACKEND_UNAVAILABLE","private desktop worker unavailable")<<std::endl;return 2;}return code;}
  std::vector<std::string> storage;
  std::vector<char*> args;
  storage.reserve(argc); args.reserve(argc);
  for (int i = 0; i < argc; ++i) {
    const int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[i], -1, nullptr, 0, nullptr, nullptr);
    if (n <= 0 || n > 32768) return 2;
    std::string value(static_cast<size_t>(n), '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[i], -1, value.data(), n, nullptr, nullptr)) return 2;
    value.pop_back(); storage.push_back(std::move(value));
  }
  for (auto& value : storage) args.push_back(value.data());
  return Run(argc, args.data());
}
