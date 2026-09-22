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
        // An image the framework gave us but whose geometry `frame_of` refuses: no error was
        // reported, the picture is simply not one we can read pixels from.
        let frame = frame_of(&image).ok_or(CaptureError::NoImage)?;
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
            // A send to a receiver that has already given up (see `HANDLER_TIMEOUT`) answers
            // `Err` and is dropped here, deliberately: the block owns the only other reference to
            // the result, so the late answer is simply released. No panic, and nothing accumulates
            // — the channel and its one buffered value die with the block.
            let _ = sender.send(Sendable(content_answer(content, error)));
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
/// ever running — is one fact: the completion handler never answered. Both become `Timeout`, which
/// is what the answer's `detail` then says, and it is a different fact from "the framework answered
/// and told us it had failed" (`Other`) or "it answered with neither a value nor an error" — which
/// is `NoContent` when it was the shareable-content query and `NoImage` when it was the screenshot,
/// because those are two different steps (see `classify_content`).
///
/// `Timeout` itself is deliberately NOT split that way: both framework calls share this one wait,
/// and "the handler never answered" is equally true and equally actionable for either, so a split
/// would buy a distinction nobody could act on. Split out from its two call sites so the mapping can
/// be tested without a window server.
fn wait_for<T>(
    receiver: &mpsc::Receiver<Sendable<Result<T, CaptureError>>>,
    timeout: Duration,
) -> Result<T, CaptureError> {
    receiver.recv_timeout(timeout).map(|sent| sent.0).unwrap_or(Err(CaptureError::Timeout))
}

fn screenshot(
    filter: &SCContentFilter,
    configuration: &SCStreamConfiguration,
) -> Result<CFRetained<CGImage>, CaptureError> {
    let (sender, receiver) = mpsc::channel::<Sendable<Result<CFRetained<CGImage>, CaptureError>>>();
    let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        // As above: no unwind across the Objective-C frame, and a late send is a harmless no-op.
        guard(|| {
            let _ = sender.send(Sendable(image_answer(image, error)));
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
///
/// A completion that brought neither an image nor an error is `NoImage` rather than `Other`: there
/// is no failure to interpret, only a missing picture, and telling the two apart is the difference
/// between "ScreenCaptureKit is erroring" and "ScreenCaptureKit is answering emptily" on a machine
/// where reading has stopped working.
///
/// This is the SCREENSHOT's mapping. The shareable-content query goes through [`classify_content`]
/// instead, because an empty answer there is a different step — see it for why that matters.
/// `Timeout` and `Other` are shared by both paths deliberately: their words ("the handler never
/// answered", "the framework reported an error we do not interpret") are true of either, so
/// splitting them would buy a distinction nobody could act on.
fn classify(error: *mut NSError) -> CaptureError {
    // SAFETY: the framework passes either null or a valid, autoreleased NSError; we only read it
    // inside this call, while the handler's autorelease pool is alive.
    let Some(error) = (unsafe { error.as_ref() }) else { return CaptureError::NoImage };
    // SAFETY: `SCStreamErrorDomain` is a framework string constant.
    let expected = unsafe { SCStreamErrorDomain };
    if error.code() == SCStreamErrorCode::UserDeclined.0 && error.domain().isEqualToString(expected) {
        CaptureError::Refused
    } else {
        CaptureError::Other
    }
}

/// What the shareable-content completion decides, given exactly what the framework handed it.
///
/// Split out of the block, and not for tidiness: a block only ever runs inside ScreenCaptureKit, so
/// nothing in a test can reach the decision it makes. That is precisely how this path came to report
/// an empty content query to the app as `captureNoImage` — naming a screenshot that had never been
/// requested — with all 245 tests green. Out here, both completions' decisions are ordinary
/// functions that a test calls with the nulls the framework itself would pass.
fn content_answer(
    content: *mut SCShareableContent,
    error: *mut NSError,
) -> Result<Retained<SCShareableContent>, CaptureError> {
    // SAFETY: the framework hands us either a valid, autoreleased SCShareableContent or null;
    // `Retained::retain` handles both and takes our own reference on the former.
    match unsafe { Retained::retain(content) } {
        Some(content) => Ok(content),
        None => Err(classify_content(error)),
    }
}

/// The same for the screenshot completion. A null image with a null error is `NoImage`: the
/// screenshot WAS requested, and no picture came back.
fn image_answer(image: *mut CGImage, error: *mut NSError) -> Result<CFRetained<CGImage>, CaptureError> {
    match std::ptr::NonNull::new(image) {
        // SAFETY: a non-null image from the framework is a valid, autoreleased CGImage;
        // `CFRetained::retain` takes our own reference on it.
        Some(image) => Ok(unsafe { CFRetained::retain(image) }),
        None => Err(classify(error)),
    }
}

/// [`classify`] for the shareable-content query, which is the FIRST framework call of a capture.
///
/// The same mapping in every respect but one: a completion that carried neither a window list nor an
/// error is `NoContent`, not `NoImage`. At that point no screenshot has been requested, so "we could
/// not read an image" would name a step that never ran — and the whole reason a `failed` read now
/// carries a word is that the word is supposed to point at the step that actually broke.
///
/// Written as a translation of `classify` rather than as a second copy of it so that the -3801
/// refusal and the "some other error" cases cannot drift apart between the two call sites; only the
/// one case that genuinely differs is rewritten.
fn classify_content(error: *mut NSError) -> CaptureError {
    match classify(error) {
        CaptureError::NoImage => CaptureError::NoContent,
        other => other,
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
        for error in [
            CaptureError::Refused,
            CaptureError::Gone,
            CaptureError::Timeout,
            CaptureError::NoContent,
            CaptureError::NoImage,
            CaptureError::Other,
        ] {
            let (sender, receiver) = mpsc::channel::<Sendable<Answer>>();
            sender.send(Sendable(Err(error))).expect("the receiver is alive");
            assert_eq!(wait_for(&receiver, TEST_TIMEOUT), Err(error), "error {error:?}");
        }
    }

    #[test]
    fn a_handler_that_never_answers_becomes_a_timeout() {
        // The sender is kept alive, exactly as the framework keeps the block alive: without the
        // timeout this is the wedge that hangs the worker thread for the life of the process.
        let (_sender, receiver) = mpsc::channel::<Sendable<Answer>>();
        assert_eq!(wait_for(&receiver, TEST_TIMEOUT), Err(CaptureError::Timeout));
    }

    /// The same fact from the other direction — the handler never answered — and so the same
    /// variant, which is what carries `captureTimeout` to the app. `Other` would say "the framework
    /// reported an error", and it did not report anything at all.
    #[test]
    fn a_handler_dropped_without_answering_becomes_the_same_timeout() {
        let (sender, receiver) = mpsc::channel::<Sendable<Answer>>();
        drop(sender);
        assert_eq!(wait_for(&receiver, TEST_TIMEOUT), Err(CaptureError::Timeout));
    }

    /// The two empty completions, told apart — at the two functions the blocks actually call, so
    /// this pins the WIRING and not just the mapping. That distinction is the whole of I1: before
    /// this, a shareable-content query that came back empty was reported to the app as
    /// `captureNoImage`, naming a screenshot that had never been requested.
    ///
    /// Null for both arguments is exactly what the framework passes when it has neither a value nor
    /// a failure to report, so this exercises the real decision with no window server, no grant and
    /// no screen involved. `matches!` rather than `assert_eq!` because the Ok side is a retained
    /// framework object with no business being compared.
    #[test]
    fn an_empty_content_completion_and_an_empty_screenshot_are_different_failures() {
        let no_error: *mut NSError = std::ptr::null_mut();
        assert!(matches!(content_answer(std::ptr::null_mut(), no_error), Err(CaptureError::NoContent)));
        assert!(matches!(image_answer(std::ptr::null_mut(), no_error), Err(CaptureError::NoImage)));
    }

    /// The one case where the two classifiers differ, asserted at the classifiers themselves. Every
    /// other case is shared by construction — `classify_content` translates `classify`'s answer
    /// rather than re-deriving it — so a -3801 refusal cannot drift between the two call sites.
    /// Building a real `NSError` would need the framework, so the reported-error cases stay
    /// compile-verified only.
    #[test]
    fn only_the_empty_completion_is_classified_differently_by_the_two_paths() {
        assert_eq!(classify_content(std::ptr::null_mut()), CaptureError::NoContent);
        assert_eq!(classify(std::ptr::null_mut()), CaptureError::NoImage);
    }

    #[test]
    fn a_late_answer_after_the_wait_gave_up_is_harmless() {
        // What the completion handler does when it finally runs: the send answers `Err` and the
        // value is dropped. Nothing panics, and nothing is left behind.
        let (sender, receiver) = mpsc::channel::<Sendable<Answer>>();
        assert_eq!(wait_for(&receiver, TEST_TIMEOUT), Err(CaptureError::Timeout));
        drop(receiver);
        assert!(sender.send(Sendable(Ok(7))).is_err());
    }
}
