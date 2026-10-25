#include "window_capture.h"
#include <dwmapi.h>
#include <wincodec.h>
#include <wincrypt.h>
#include <wrl/client.h>
#include <cstdio>
#include <string>
using Microsoft::WRL::ComPtr;
int failures=0;
#define CHECK(v) do{if(!(v)){++failures;std::printf("FAIL line %d: %s\n",__LINE__,#v);}}while(false)
std::vector<unsigned char> Decode(const std::string& encoded) {
  DWORD size=0; if(!CryptStringToBinaryA(encoded.data(),static_cast<DWORD>(encoded.size()),CRYPT_STRING_BASE64,nullptr,&size,nullptr,nullptr))return {};
  std::vector<unsigned char> bytes(size);
  if(!CryptStringToBinaryA(encoded.data(),static_cast<DWORD>(encoded.size()),CRYPT_STRING_BASE64,bytes.data(),&size,nullptr,nullptr))return {};
  ComPtr<IWICImagingFactory> factory;ComPtr<IWICStream> stream;ComPtr<IWICBitmapDecoder> decoder;ComPtr<IWICBitmapFrameDecode> frame;ComPtr<IWICFormatConverter> convert;
  if(FAILED(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&factory)))||
     FAILED(factory->CreateStream(&stream))||FAILED(stream->InitializeFromMemory(bytes.data(),size))||
     FAILED(factory->CreateDecoderFromStream(stream.Get(),nullptr,WICDecodeMetadataCacheOnLoad,&decoder))||
     FAILED(decoder->GetFrame(0,&frame))||FAILED(factory->CreateFormatConverter(&convert))||
     FAILED(convert->Initialize(frame.Get(),GUID_WICPixelFormat32bppBGRA,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom)))return {};
  UINT width=0,height=0;if(FAILED(convert->GetSize(&width,&height)))return {};
  std::vector<unsigned char> pixels(static_cast<size_t>(width)*height*4);
  if(FAILED(convert->CopyPixels(nullptr,width*4,static_cast<UINT>(pixels.size()),pixels.data())))return {};
  return pixels;
}
LRESULT CALLBACK WindowProc(HWND h,UINT msg,WPARAM w,LPARAM l) {
  if(msg==WM_PAINT) {PAINTSTRUCT paint{};HDC dc=BeginPaint(h,&paint);RECT rect{};GetClientRect(h,&rect);
    auto brush=CreateSolidBrush(RGB(23,67,191));FillRect(dc,&rect,brush);DeleteObject(brush);EndPaint(h,&paint);return 0;}
  return DefWindowProcW(h,msg,w,l);
}
int main(int argc,char** argv) {
  CHECK(SUCCEEDED(CoInitializeEx(nullptr,COINIT_MULTITHREADED)));
  adl::WindowPixels p;p.bounds={-10,20,-6,23};p.width=4;p.height=3;p.bgra.resize(48,255);
  for(size_t n=0;n<p.bgra.size();n+=4){p.bgra[n]=191;p.bgra[n+1]=67;p.bgra[n+2]=23;}
  std::string encoded;
  CHECK(adl::EncodeWindowPixels(p,{{-9,21,9000,9000}},encoded).ok());
  const auto decoded=Decode(encoded);CHECK(decoded.size()==48);
  if(decoded.size()==48){CHECK(decoded[0]==191);CHECK(decoded[4*5]==0);CHECK(decoded[4*5+3]==255);CHECK(decoded[4*4]==191);}
  adl::WindowPixels invalid;invalid.width=4097;invalid.height=1;
  CHECK(!adl::EncodeWindowPixels(invalid,{},encoded).ok());CHECK(encoded.empty());
  std::printf("PNG masks, negative desktop origin, bounds and format: %s\n",failures?"FAIL":"PASS");
  if(argc>1&&std::string(argv[1])=="--interactive") {
    CHECK(SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)||AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2));
    const auto foreground=GetForegroundWindow();POINT cursor{};CHECK(GetCursorPos(&cursor));
    WNDCLASSW wc{};wc.lpfnWndProc=WindowProc;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"ADLExactWindowCaptureTest";RegisterClassW(&wc);
    HWND window=CreateWindowExW(WS_EX_NOACTIVATE,wc.lpszClassName,L"AgentDeskLink synthetic capture fixture",WS_OVERLAPPEDWINDOW,80,80,420,240,nullptr,nullptr,wc.hInstance,nullptr);
    CHECK(window!=nullptr);ShowWindow(window,SW_SHOWNOACTIVATE);UpdateWindow(window);DwmFlush();
    auto destroyed=std::make_shared<std::atomic<bool>>(false);adl::WindowPixels pixels;
    const auto status=adl::ReadWindowPixels(window,destroyed,pixels);
    if(!status.ok())std::printf("WGC failure: %s %s\n",status.code,status.message.c_str());
    CHECK(status.ok());CHECK(pixels.width>0&&pixels.height>0);CHECK(pixels.bgra.size()==static_cast<size_t>(pixels.width)*pixels.height*4);
    bool synthetic_blue=false;for(size_t n=0;n+3<pixels.bgra.size();n+=4)if(pixels.bgra[n]==191&&pixels.bgra[n+1]==67&&pixels.bgra[n+2]==23)synthetic_blue=true;
    CHECK(synthetic_blue);CHECK(adl::EncodeWindowPixels(pixels,{},encoded).ok());CHECK(!Decode(encoded).empty());
    POINT after{};CHECK(GetCursorPos(&after));CHECK(cursor.x==after.x&&cursor.y==after.y);CHECK(foreground==GetForegroundWindow());
    DestroyWindow(window);destroyed->store(true);CHECK(!adl::ReadWindowPixels(window,destroyed,pixels).ok());CHECK(pixels.bgra.empty());
    UnregisterClassW(wc.lpszClassName,wc.hInstance);
    std::printf("Exact-window WGC synthetic fixture, closed target, no focus/cursor changes: %s\n",failures?"FAIL":"PASS");
  }
  CoUninitialize();return failures?1:0;
}
