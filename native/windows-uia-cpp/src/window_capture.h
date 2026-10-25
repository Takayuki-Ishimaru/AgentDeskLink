#pragma once
#include <windows.h>
#include <atomic>
#include <memory>
#include <vector>
#include "protocol.h"
namespace adl {
// One exact-window WGC frame. No desktop/monitor/PrintWindow fallback exists.
struct WindowPixels {
  RECT bounds{};
  unsigned width = 0, height = 0;
  std::vector<unsigned char> bgra;
  std::string captured_at;
};
Status ReadWindowPixels(HWND hwnd, const std::shared_ptr<std::atomic<bool>>& destroyed, WindowPixels& out);
Status EncodeWindowPixels(WindowPixels& pixels, const std::vector<RECT>& masks, std::string& base64);
}
