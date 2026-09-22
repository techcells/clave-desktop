//! Capturing one window, by window-server id, with ScreenCaptureKit.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2::rc::{Retained, autoreleasepool};
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{CGDataProvider, CGImage};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCStreamErrorCode,
    SCStreamErrorDomain, SCWindow,
};

use super::Sendable;
use crate::frame::Frame;
use crate::platform::{CaptureError, Captured};
use crate::runtime::guard;

/// How long to wait for a ScreenCaptureKit completion handler before giving up on it.
///
/// `recv()` with no timeout would be a permanent hang: it only returns `Err` when every sender is
/// dropped, and the framework holds the block (and therefore the sender) for as long as it likes.
/// A handler that never fires — a window-server hiccup, a display reconfiguration mid-capture —
/// would then wedge the worker thread for the life of the process, with `permission` and
/// `frontWindow` still answering on the input thread so the helper looks healthy while every read
/// queues behind the dead one. The app does rescue that (it kills a helper that misses its
/// deadline), but at the cost of a restart and another warm-up. Three seconds is twice the
/// 1 500 ms read budget the app normally asks for, so a capture that is merely slow still lands,
/// and a capture that is gone answers `failed` while the helper stays usable.
const HANDLER_TIMEOUT: Duration = Duration::from_secs(3);

/// Capture the window with this window-server id.
///
/// The id, not "whatever is in front now": the front window was decided a step earlier, and if the
/// user has switched apps since, the honest answer is that the window is gone.
pub fn capture(window_id: u32) -> Result<Captured<CFRetained<CGImage>>, CaptureError> {
    autoreleasepool(|_| {
        let content = shareable_content()?;
        let window = find_window(&content, window_id).ok_or(CaptureError::Gone)?;

        // SAFETY: `window` is a live SCWindow from the content we just fetched, which is what
        // `initWithDesktopIndependentWindow:` is documented to take. The window-server prologue in
        // `macos::prologue` has already run, without which this call aborts inside SkyLight.
        let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window) };
        // SAFETY: plain property reads on the filter we just built.
        let (rect, scale) = unsafe { (filter.contentRect(), filter.pointPixelScale() as f64) };

        // SAFETY: `SCStreamConfiguration::new` is the designated initialiser and the setters below
        // are its declared properties.
        let configuration = unsafe { SCStreamConfiguration::new() };
        unsafe {
            // Ask for the window's own pixels at the display's density: the sharper the glyphs, the
            // better the recognition, and phase 0's accuracy figures were measured this way.
            configuration.setWidth((rect.size.width * scale) as usize);
            configuration.setHeight((rect.size.height * scale) as usize);
            // The pointer is not part of the window's content, and a shadow is a band of the
            // desktop behind the window — i.e. of another app's pixels.
            configuration.setShowsCursor(false);
            configuration.setIgnoreShadowsSingleWindow(true);
        }

        let image = screenshot(&filter, &configuration)?;
        let frame = frame_of(&image).ok_or(CaptureError::Other)?;
        Ok(Captured { frame, scale, image })
    })
}

fn find_window(content: &SCShareableContent, window_id: u32) -> Option<Retained<SCWindow>> {
    // SAFETY: `windows` is a declared property returning an array of SCWindow.
    let windows = unsafe { content.windows() };
    // SAFETY: `windowID` is a declared property of SCWindow.
    windows.iter().find(|window| unsafe { window.windowID() } == window_id)
}

/// The shareable content, fetched synchronously.
///
/// The completion handler fires on one of ScreenCaptureKit's own queues while this thread blocks on
/// the channel. Phase 0 established that this works with no run loop running on the calling thread,
/// which is what lets the read live on a plain worker thread.
fn shareable_content() -> Result<Retained<SCShareableContent>, CaptureError> {
    let (sender, receiver) = mpsc::channel::<Sendable<Result<Retained<SCShareableContent>, CaptureError>>>();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // The block is called from Objective-C, across which a Rust unwind is undefined behaviour;
        // `guard` turns a panic in here into the same `E_PANIC` exit 70 as any thread body.
        guard(|| {
            // SAFETY: the framework hands us either a valid, autoreleased SCShareableContent or
            // null; `Retained::retain` handles both and takes our own reference on the former.
            let result = match unsafe { Retained::retain(content) } {
                Some(content) => Ok(content),
                None => Err(classify(error)),
            };
            // A send to a receiver that has already given up (see `HANDLER_TIMEOUT`) answers
            // `Err` and is dropped here, deliberately: the block owns the only other reference to
            // the result, so the late answer is simply released. No panic, and nothing accumulates
            // — the channel and its one buffered value die with the block.
            let _ = sender.send(Sendable(result));
        });
    });
    // SAFETY: the block matches the declared completion-handler signature and is retained by the
    // framework for the duration of the call.
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, true, &handler,
        );
    }
    wait_for(&receiver, HANDLER_TIMEOUT)
}

/// Wait for a completion handler's answer, or give up on it.
///
/// Either error from `recv_timeout` — nothing arrived in time, or the block was dropped without
/// ever running — is a framework failure we cannot tell apart and do not interpret, so both become
/// the same `Other`. Split out from its two call sites so the mapping can be tested without a
/// window server.
fn wait_for<T>(
    receiver: &mpsc::Receiver<Sendable<Result<T, CaptureError>>>,
    timeout: Duration,
) -> Result<T, CaptureError> {
    receiver.recv_timeout(timeout).map(|sent| sent.0).unwrap_or(Err(CaptureError::Other))
}

fn screenshot(
    filter: &SCContentFilter,
    configuration: &SCStreamConfiguration,
) -> Result<CFRetained<CGImage>, CaptureError> {
    let (sender, receiver) = mpsc::channel::<Sendable<Result<CFRetained<CGImage>, CaptureError>>>();
    let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        // As above: no unwind across the Objective-C frame, and a late send is a harmless no-op.
        guard(|| {
            let result = match std::ptr::NonNull::new(image) {
                // SAFETY: a non-null image from the framework is a valid, autoreleased CGImage;
                // `CFRetained::retain` takes our own reference on it.
                Some(image) => Ok(unsafe { CFRetained::retain(image) }),
                None => Err(classify(error)),
            };
            let _ = sender.send(Sendable(result));
        });
    });
    // SAFETY: the block matches the declared completion-handler signature.
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            filter,
            configuration,
            Some(&handler),
        );
    }
    wait_for(&receiver, HANDLER_TIMEOUT)
}

/// Turn a framework error into the one distinction that changes what we do.
///
/// `SCStreamErrorDomain` -3801 (`SCStreamErrorUserDeclined`) is the measured signature of "no
/// Screen Recording grant is in force for this process", both when it was never granted and when
/// the user switched it off under a running helper. Everything else is a failure we do not
/// interpret — and we never put the error's text anywhere, because a framework message is one more
/// place a window's name could surface.
fn classify(error: *mut NSError) -> CaptureError {
    // SAFETY: the framework passes either null or a valid, autoreleased NSError; we only read it
    // inside this call, while the handler's autorelease pool is alive.
    let Some(error) = (unsafe { error.as_ref() }) else { return CaptureError::Other };
    // SAFETY: `SCStreamErrorDomain` is a framework string constant.
    let expected = unsafe { SCStreamErrorDomain };
    if error.code() == SCStreamErrorCode::UserDeclined.0 && error.domain().isEqualToString(expected) {
        CaptureError::Refused
    } else {
        CaptureError::Other
    }
}

/// Copy the image's pixels out into a plain buffer.
///
/// A copy, not a borrow: the rest of the read is platform-neutral code that must be able to hash
/// and sample the pixels without holding a CoreGraphics object alive, and at roughly 3.5 MB for a
/// typical window the copy costs well under a millisecond against a read that takes about 90.
fn frame_of(image: &CGImage) -> Option<Frame> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let bytes_per_row = CGImage::bytes_per_row(Some(image));
    let bits_per_pixel = CGImage::bits_per_pixel(Some(image));
    if width == 0 || height == 0 || bits_per_pixel == 0 || bits_per_pixel % 8 != 0 {
        return None;
    }
    let bytes_per_pixel = bits_per_pixel / 8;
    let provider = CGImage::data_provider(Some(image))?;
    let data = CGDataProvider::data(Some(&provider))?;
    let bytes = data.to_vec();
    // Refuse a buffer that does not cover the geometry it claims, rather than reasoning about it
    // later inside the sampling loops.
    if bytes.len() < height.saturating_sub(1) * bytes_per_row + width * bytes_per_pixel {
        return None;
    }
    Some(Frame { width, height, bytes_per_row, bytes_per_pixel, data: bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Short enough that the tests are instant; the mapping under test is the same one
    /// `HANDLER_TIMEOUT` drives in the two real call sites.
    const TEST_TIMEOUT: Duration = Duration::from_millis(20);

    /// A stand-in for a retained framework object: `wait_for` never looks inside the payload.
    type Answer = Result<u32, CaptureError>;

    #[test]
    fn an_answer_that_arrives_in_time_is_passed_through() {
        let (sender, receiver) = mpsc::channel::<Sendable<Answer>>();
        sender.send(Sendable(Ok(7))).expect("the receiver is alive");
        assert_eq!(wait_for(&receiver, TEST_TIMEOUT), Ok(7));
    }

    #[test]
    fn a_failure_reported_by_the_handler_is_passed_through_unchanged() {
        for error in [CaptureError::Refused, CaptureError::Gone, CaptureError::Other] {
            let (sender, receiver) = mpsc::channel::<Sendable<Answer>>();
            sender.send(Sendable(Err(error))).expect("the receiver is alive");
            assert_eq!(wait_for(&receiver, TEST_TIMEOUT), Err(error), "error {error:?}");
        }
    }

    #[test]
    fn a_handler_that_never_answers_becomes_a_plain_failure() {
        // The sender is kept alive, exactly as the framework keeps the block alive: without the
        // timeout this is the wedge that hangs the worker thread for the life of the process.
        let (_sender, receiver) = mpsc::channel::<Sendable<Answer>>();
        assert_eq!(wait_for(&receiver, TEST_TIMEOUT), Err(CaptureError::Other));
    }

    #[test]
    fn a_handler_dropped_without_answering_becomes_the_same_plain_failure() {
        let (sender, receiver) = mpsc::channel::<Sendable<Answer>>();
        drop(sender);
        assert_eq!(wait_for(&receiver, TEST_TIMEOUT), Err(CaptureError::Other));
    }

    #[test]
    fn a_late_answer_after_the_wait_gave_up_is_harmless() {
        // What the completion handler does when it finally runs: the send answers `Err` and the
        // value is dropped. Nothing panics, and nothing is left behind.
        let (sender, receiver) = mpsc::channel::<Sendable<Answer>>();
        assert_eq!(wait_for(&receiver, TEST_TIMEOUT), Err(CaptureError::Other));
        drop(receiver);
        assert!(sender.send(Sendable(Ok(7))).is_err());
    }
}
