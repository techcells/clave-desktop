//! Capturing one window, by handle, with Windows.Graphics.Capture.
//!
//! The same shape as the macOS capture: the window the scheduler approved, by id, and nothing
//! else — a window that has gone is `Gone`, never a capture of whatever replaced it. Windows.Graphics
//! .Capture renders the window's own content even when other windows cover it, as ScreenCaptureKit's
//! desktop-independent filter does, so nothing of another app lands in the frame.

use std::cell::RefCell;
use std::time::{Duration, Instant};

use ::windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use ::windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use ::windows::Graphics::DirectX::DirectXPixelFormat;
use ::windows::Win32::Foundation::HMODULE;
use ::windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use ::windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
    ID3D11DeviceContext, ID3D11Texture2D,
};
use ::windows::Win32::Graphics::Dxgi::IDXGIDevice;
use ::windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use ::windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use ::windows::Win32::UI::WindowsAndMessaging::IsWindow;
use ::windows::core::{Interface, factory};

use super::windows::{hwnd_of, scale_of};
use crate::frame::Frame;
use crate::platform::{CaptureError, Captured};

/// How long to wait for the first frame. The same three seconds as the macOS completion handlers,
/// for the same reason: twice the app's usual read budget, so a slow capture still lands and a
/// capture that never comes answers `failed` instead of wedging the worker.
const FRAME_TIMEOUT: Duration = Duration::from_secs(3);

/// How often the frame pool is asked for its frame while waiting.
const FRAME_POLL: Duration = Duration::from_millis(4);

/// The Direct3D device the captures render into, one per thread that captures (in practice, the
/// worker). Creating one costs tens of milliseconds, far more than a capture, so it is kept.
struct Devices {
    d3d: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt: IDirect3DDevice,
}

thread_local! {
    static DEVICES: RefCell<Option<Devices>> = const { RefCell::new(None) };
}

fn create_devices() -> Option<Devices> {
    // The GPU first; WARP, Windows' software rasteriser, where there is none (a VM, a remote session).
    [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP].into_iter().find_map(create_devices_on)
}

fn create_devices_on(driver: D3D_DRIVER_TYPE) -> Option<Devices> {
    let mut d3d = None;
    let mut context = None;
    // SAFETY: the out-pointers are valid for the call; BGRA support is what capture frames need.
    unsafe {
        D3D11CreateDevice(
            None,
            driver,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut d3d),
            None,
            Some(&mut context),
        )
        .ok()?;
    }
    let (d3d, context) = (d3d?, context?);
    let dxgi: IDXGIDevice = d3d.cast().ok()?;
    // SAFETY: a live DXGI device, as the call requires.
    let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }.ok()?.cast().ok()?;
    Some(Devices { d3d, context, winrt })
}

/// Capture the window with this handle.
pub fn capture(window_id: u32) -> Result<Captured<()>, CaptureError> {
    let hwnd = hwnd_of(window_id);
    // SAFETY: a plain validity check on a handle value.
    if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return Err(CaptureError::Gone);
    }
    let scale = scale_of(hwnd);
    DEVICES.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = create_devices();
        }
        let devices = slot.as_ref().ok_or(CaptureError::Other)?;
        let result = capture_with(devices, hwnd);
        // A device that has been lost (a driver update, a GPU reset) fails every capture after it.
        // Dropping it on any failure costs one re-creation and cures that for the next read.
        if result.is_err() {
            *slot = None;
        }
        result.map(|frame| Captured { frame, scale, image: () })
    })
}

fn capture_with(devices: &Devices, hwnd: ::windows::Win32::Foundation::HWND) -> Result<Frame, CaptureError> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|_| CaptureError::Other)?;
    // A window that closed between the check above and here fails to make an item: it is gone.
    // SAFETY: a window handle, as `CreateForWindow` takes.
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(hwnd) }.map_err(|_| CaptureError::Gone)?;
    let size = item.Size().map_err(|_| CaptureError::Other)?;
    if size.Width <= 0 || size.Height <= 0 {
        return Err(CaptureError::NoImage);
    }

    let pool =
        Direct3D11CaptureFramePool::CreateFreeThreaded(&devices.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size)
            .map_err(|_| CaptureError::Other)?;
    let session = pool.CreateCaptureSession(&item).map_err(|_| CaptureError::Other)?;
    // The pointer is not part of the window's content. The yellow border is Windows telling the user
    // a capture is running; Windows 11 lets a program without a UI of its own go without it, and on
    // Windows 10 the setter does not exist and the border stays, which is the system's call.
    let _ = session.SetIsCursorCaptureEnabled(false);
    let _ = session.SetIsBorderRequired(false);
    session.StartCapture().map_err(|_| CaptureError::Other)?;

    let deadline = Instant::now() + FRAME_TIMEOUT;
    let frame = loop {
        if let Ok(frame) = pool.TryGetNextFrame() {
            break Ok(frame);
        }
        if Instant::now() >= deadline {
            break Err(CaptureError::Timeout);
        }
        std::thread::sleep(FRAME_POLL);
    };
    // Stop at once: one frame is all a read wants, and a running session keeps rendering the window.
    let copied = frame.and_then(|frame| {
        let content = frame.ContentSize().map_err(|_| CaptureError::NoImage)?;
        let surface = frame.Surface().map_err(|_| CaptureError::NoImage)?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(|_| CaptureError::NoImage)?;
        // SAFETY: the surface of a frame we hold, asked for the texture it is.
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(|_| CaptureError::NoImage)?;
        let copy = read_pixels(devices, &texture, content.Width, content.Height);
        let _ = frame.Close();
        copy
    });
    let _ = session.Close();
    let _ = pool.Close();
    copied
}

/// Copy the frame's texture back to memory, cropped to the window's content size.
///
/// The frame pool's buffers are the size the item had when the pool was made; a window resized in
/// the meantime renders into part of that, and `ContentSize` says which part. The copy is tightly
/// packed (`bytes_per_row == width * 4`), which the recogniser relies on.
fn read_pixels(devices: &Devices, texture: &ID3D11Texture2D, width: i32, height: i32) -> Result<Frame, CaptureError> {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: filling a description struct we own.
    unsafe { texture.GetDesc(&mut desc) };
    let width = (width.max(0) as u32).min(desc.Width) as usize;
    let height = (height.max(0) as u32).min(desc.Height) as usize;
    if width == 0 || height == 0 {
        return Err(CaptureError::NoImage);
    }

    // A texture the CPU can read, the same format and size as the frame's.
    let staging_desc = D3D11_TEXTURE2D_DESC {
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
        ..desc
    };
    let mut staging = None;
    // SAFETY: a valid description and out-pointer; no initial data.
    unsafe { devices.d3d.CreateTexture2D(&staging_desc, None, Some(&mut staging)) }.map_err(|_| CaptureError::NoImage)?;
    let staging = staging.ok_or(CaptureError::NoImage)?;

    // SAFETY: both textures are live and identical in size and format; the mapping is read only
    // within the rows and row pitch it reports, and unmapped before the texture is dropped.
    unsafe {
        devices.context.CopyResource(&staging, texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        devices.context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(|_| CaptureError::NoImage)?;
        let pitch = mapped.RowPitch as usize;
        let row_bytes = width * 4;
        let source = mapped.pData as *const u8;
        let mut data = vec![0u8; row_bytes * height];
        if !source.is_null() && pitch >= row_bytes {
            for y in 0..height {
                std::ptr::copy_nonoverlapping(source.add(y * pitch), data.as_mut_ptr().add(y * row_bytes), row_bytes);
            }
        }
        devices.context.Unmap(&staging, 0);
        if source.is_null() || pitch < row_bytes {
            return Err(CaptureError::NoImage);
        }
        Ok(Frame { width, height, bytes_per_row: row_bytes, bytes_per_pixel: 4, data })
    }
}
