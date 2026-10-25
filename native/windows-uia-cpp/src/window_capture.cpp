#include "window_capture.h"
#include <d3d11.h>
#include <dwmapi.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <roapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <cstdio>
#include <cstring>

namespace adl {
namespace {
using Microsoft::WRL::ComPtr;
using namespace winrt::Windows::Graphics::Capture;
constexpr unsigned kMaxSide = 4096;
constexpr unsigned kMaxPixels = 4194304;
constexpr size_t kMaxPngBytes = 8 * 1024 * 1024;
struct Resources {
  Direct3D11CaptureFramePool pool{nullptr};
  GraphicsCaptureSession session{nullptr};
  ~Resources() {
    try { if(session) session.Close(); } catch (...) {}
    try { if(pool) pool.Close(); } catch (...) {}
  }
};
bool Live(HWND window, const std::shared_ptr<std::atomic<bool>>& destroyed) {
  return destroyed && !destroyed->load() && IsWindow(window) && IsWindowVisible(window) && !IsIconic(window);
}
std::string Base64(const unsigned char* data, size_t size) {
  static const char table[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out; out.reserve(4*((size+2)/3));
  for(size_t i=0;i<size;i+=3) {
    const unsigned v=(static_cast<unsigned>(data[i])<<16) |
      (i+1<size?static_cast<unsigned>(data[i+1])<<8:0) | (i+2<size?data[i+2]:0);
    out.push_back(table[(v>>18)&63]);out.push_back(table[(v>>12)&63]);
    out.push_back(i+1<size?table[(v>>6)&63]:'=');out.push_back(i+2<size?table[v&63]:'=');
  }
  return out;
}
Status Unavailable() { return Status::Fail("E_BACKEND_UNAVAILABLE","exact-window graphics capture is unavailable"); }
}

Status ReadWindowPixels(HWND hwnd, const std::shared_ptr<std::atomic<bool>>& destroyed, WindowPixels& out) {
  out=WindowPixels{};
  if(!Live(hwnd,destroyed)) return Status::Fail("E_TARGET_NOT_FOUND","capture target is not live");
  const HRESULT initialized=RoInitialize(RO_INIT_MULTITHREADED);
  if(FAILED(initialized))return Unavailable();
  struct Runtime {~Runtime(){RoUninitialize();}} runtime;
  try {
    if(!GraphicsCaptureSession::IsSupported()) return Status::Fail("E_UNSUPPORTED_ACTION","Windows Graphics Capture is unsupported");
    RECT bounds{};
    if(FAILED(DwmGetWindowAttribute(hwnd,DWMWA_EXTENDED_FRAME_BOUNDS,&bounds,sizeof bounds))) return Unavailable();
    ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL level{};
    HRESULT hr=D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr,0,D3D11_SDK_VERSION,&device,&level,&context);
    if(hr==DXGI_ERROR_UNSUPPORTED) {
      hr=D3D11CreateDevice(nullptr,D3D_DRIVER_TYPE_WARP,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        nullptr,0,D3D11_SDK_VERSION,&device,&level,&context);
    }
    if(FAILED(hr)) return Unavailable();
    ComPtr<IDXGIDevice> dxgi; if(FAILED(device.As(&dxgi))) return Unavailable();
    winrt::com_ptr<IInspectable> inspectable;
    winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(),inspectable.put()));
    auto winrt_device=inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
    auto factory=winrt::get_activation_factory<GraphicsCaptureItem,IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{nullptr};
    winrt::check_hresult(factory->CreateForWindow(hwnd,winrt::guid_of<GraphicsCaptureItem>(),winrt::put_abi(item)));
    const auto size=item.Size();
    if(size.Width<=0||size.Height<=0||size.Width>static_cast<int>(kMaxSide)||size.Height>static_cast<int>(kMaxSide)||
       static_cast<unsigned long long>(size.Width)*size.Height>kMaxPixels)
      return Status::Fail("E_RESOURCE_LIMIT","capture target exceeds bounded source dimensions");
    // The PNG's origin must have an exact physical-pixel mapping. Never guess a
    // border offset: mismatched geometry cannot safely mask sensitive controls.
    if(bounds.right-bounds.left!=size.Width||bounds.bottom-bounds.top!=size.Height)
      return Status::Fail("E_STALE_STATE","window and capture geometry do not agree");
    Resources resources;
    resources.pool=Direct3D11CaptureFramePool::CreateFreeThreaded(winrt_device,
      winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,1,size);
    resources.session=resources.pool.CreateCaptureSession(item);
    resources.session.IsCursorCaptureEnabled(false); // No unrelated cursor disclosure.
    const ULONGLONG deadline=GetTickCount64()+1500;
    resources.session.StartCapture();
    Direct3D11CaptureFrame frame{nullptr};
    while(!frame) {
      if(!Live(hwnd,destroyed)) return Status::Fail("E_TARGET_NOT_FOUND","capture target closed");
      if(GetTickCount64()>=deadline) return Status::Fail("E_TIMEOUT","window produced no capture frame before deadline");
      frame=resources.pool.TryGetNextFrame();
      if(!frame) Sleep(5);
    }
    const auto frame_size=frame.ContentSize();
    if(frame_size.Width!=size.Width||frame_size.Height!=size.Height)
      return Status::Fail("E_STALE_STATE","window resized while a frame was captured");
    auto access=frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    ComPtr<ID3D11Texture2D> source;
    winrt::check_hresult(access->GetInterface(IID_PPV_ARGS(source.GetAddressOf())));
    D3D11_TEXTURE2D_DESC desc{};source->GetDesc(&desc);
    if(desc.Width<static_cast<UINT>(size.Width)||desc.Height<static_cast<UINT>(size.Height)||desc.Format!=DXGI_FORMAT_B8G8R8A8_UNORM)
      return Unavailable();
    desc.Width=static_cast<UINT>(size.Width);desc.Height=static_cast<UINT>(size.Height);
    desc.Usage=D3D11_USAGE_STAGING;desc.BindFlags=0;desc.CPUAccessFlags=D3D11_CPU_ACCESS_READ;desc.MiscFlags=0;
    desc.ArraySize=1;desc.MipLevels=1;desc.SampleDesc.Count=1;desc.SampleDesc.Quality=0;
    ComPtr<ID3D11Texture2D> staging;
    winrt::check_hresult(device->CreateTexture2D(&desc,nullptr,&staging));
    D3D11_BOX box{0,0,0,static_cast<UINT>(size.Width),static_cast<UINT>(size.Height),1};
    context->CopySubresourceRegion(staging.Get(),0,0,0,0,source.Get(),0,&box);
    context->Flush();
    D3D11_MAPPED_SUBRESOURCE mapped{};
    for(;;) {
      if(!Live(hwnd,destroyed)) return Status::Fail("E_TARGET_NOT_FOUND","capture target closed");
      if(GetTickCount64()>=deadline) return Status::Fail("E_TIMEOUT","capture GPU readback exceeded deadline");
      hr=context->Map(staging.Get(),0,D3D11_MAP_READ,D3D11_MAP_FLAG_DO_NOT_WAIT,&mapped);
      if(hr==DXGI_ERROR_WAS_STILL_DRAWING) {Sleep(5);continue;}
      winrt::check_hresult(hr);break;
    }
    struct Unmap { ID3D11DeviceContext* context;ID3D11Texture2D* texture;~Unmap(){context->Unmap(texture,0);} } unmap{context.Get(),staging.Get()};
    out.bgra.resize(static_cast<size_t>(size.Width)*size.Height*4);
    for(int y=0;y<size.Height;y++) {
      auto* row=out.bgra.data()+static_cast<size_t>(y)*size.Width*4;
      std::memcpy(row,static_cast<const unsigned char*>(mapped.pData)+static_cast<size_t>(y)*mapped.RowPitch,static_cast<size_t>(size.Width)*4);
      for(int x=0;x<size.Width;x++)row[static_cast<size_t>(x)*4+3]=255;
    }
    RECT after{};
    if(!Live(hwnd,destroyed)||FAILED(DwmGetWindowAttribute(hwnd,DWMWA_EXTENDED_FRAME_BOUNDS,&after,sizeof after))||
       !EqualRect(&bounds,&after)) {out=WindowPixels{};return Status::Fail("E_STALE_STATE","window moved or closed during capture");}
    SYSTEMTIME now{};GetSystemTime(&now);char time[40];
    std::snprintf(time,sizeof time,"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",now.wYear,now.wMonth,now.wDay,now.wHour,now.wMinute,now.wSecond,now.wMilliseconds);
    out.bounds=bounds;out.width=static_cast<unsigned>(size.Width);out.height=static_cast<unsigned>(size.Height);out.captured_at=time;
    return Status::Ok();
  } catch(const winrt::hresult_error& e) {
    out=WindowPixels{};
    if(e.code()==E_ACCESSDENIED) return Status::Fail("E_POLICY_DENIED","Windows denied exact-window capture");
    return Unavailable();
  } catch(...) {out=WindowPixels{};return Unavailable();}
}

Status EncodeWindowPixels(WindowPixels& p, const std::vector<RECT>& masks, std::string& base64) {
  base64.clear();
  if(!p.width||!p.height||p.width>kMaxSide||p.height>kMaxSide||static_cast<unsigned long long>(p.width)*p.height>kMaxPixels||
     p.bgra.size()!=static_cast<size_t>(p.width)*p.height*4) return Status::Fail("E_RESOURCE_LIMIT","invalid bounded capture buffer");
  for(const RECT& r:masks) {
    const LONG left=std::max(r.left,p.bounds.left),right=std::min(r.right,p.bounds.right);
    const LONG top=std::max(r.top,p.bounds.top),bottom=std::min(r.bottom,p.bounds.bottom);
    for(LONG y=top;y<bottom;y++) for(LONG x=left;x<right;x++) {
      auto* pixel=p.bgra.data()+(static_cast<size_t>(y-p.bounds.top)*p.width+static_cast<size_t>(x-p.bounds.left))*4;
      pixel[0]=pixel[1]=pixel[2]=0;pixel[3]=255;
    }
  }
  ComPtr<IWICImagingFactory> factory;
  if(FAILED(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&factory))))return Unavailable();
  ComPtr<IStream> stream;
  if(FAILED(CreateStreamOnHGlobal(nullptr,TRUE,&stream)))return Unavailable();
  ComPtr<IWICBitmapEncoder> encoder;
  if(FAILED(factory->CreateEncoder(GUID_ContainerFormatPng,nullptr,&encoder))||FAILED(encoder->Initialize(stream.Get(),WICBitmapEncoderNoCache)))return Unavailable();
  ComPtr<IWICBitmapFrameEncode> frame;
  if(FAILED(encoder->CreateNewFrame(&frame,nullptr))||FAILED(frame->Initialize(nullptr))||FAILED(frame->SetSize(p.width,p.height)))return Unavailable();
  WICPixelFormatGUID format=GUID_WICPixelFormat32bppBGRA;
  if(FAILED(frame->SetPixelFormat(&format))||!IsEqualGUID(format,GUID_WICPixelFormat32bppBGRA)||
     FAILED(frame->WritePixels(p.height,p.width*4,static_cast<UINT>(p.bgra.size()),p.bgra.data()))||
     FAILED(frame->Commit())||FAILED(encoder->Commit()))return Unavailable();
  STATSTG stat{};
  if(FAILED(stream->Stat(&stat,STATFLAG_NONAME)))return Unavailable();
  if(stat.cbSize.QuadPart>kMaxPngBytes)return Status::Fail("E_RESOURCE_LIMIT","encoded capture exceeds PNG byte limit");
  HGLOBAL memory=nullptr;if(FAILED(GetHGlobalFromStream(stream.Get(),&memory)))return Unavailable();
  const auto* data=static_cast<const unsigned char*>(GlobalLock(memory));if(!data)return Unavailable();
  base64=Base64(data,static_cast<size_t>(stat.cbSize.QuadPart));GlobalUnlock(memory);
  return Status::Ok();
}
}
