//! The PipeWire side of a ScreenCast session: one thread, one stream per monitor, and the latest
//! frame of each kept where the compositor put it.
//!
//! GNOME sends a frame only when something on screen changes, so waiting for "the next frame" could
//! wait for ever on a still screen. Instead each stream keeps the most recent usable buffer it was
//! given (and gives the previous one back), and a crop is copied out of that buffer on request. The
//! whole monitor is never copied: the buffer is the compositor's shared memory, and only the window's
//! rectangle leaves it (design 4.4).
//!
//! A crop names the moment its window was last seen to change (focus or geometry): a frame that
//! arrived before it may still show what was under that rectangle before, so it is not used, and the
//! crop waits for the next frame instead (Task 3 review, I3).
//!
//! PipeWire objects must stay on the thread that made them, so everything here runs on the
//! session's own thread; the rest of the helper talks to it through a PipeWire channel and gets its
//! answer on an ordinary one.

use std::cell::RefCell;
use std::os::fd::OwnedFd;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use pipewire as pw;
use pw::spa;
use pw::spa::param::format::{FormatProperties, MediaSubtype, MediaType};
use pw::spa::param::video::{VideoFormat, VideoInfoRaw};
use pw::spa::pod::Pod;
use pw::stream::StreamState;

use super::crop::{PixelRect, copy_window, crop_rect};
use super::extension::Rect;
use crate::frame::Frame;

/// The most frames a second each stream is asked for. Only the latest frame is ever used, and a
/// read happens at most every few seconds, so a low rate keeps the compositor's work small.
const MAX_FRAMES_PER_SECOND: u32 = 5;

/// Why a crop was not made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CropError {
    /// No stream for that node (it never connected).
    NoStream,
    /// The window is not on that stream's monitor.
    OffMonitor,
    /// The stream has no usable frame (not negotiated, a format this module does not read, a
    /// buffer without mapped memory, a corrupted chunk).
    NoImage,
}

/// One crop, asked of the session thread.
pub struct CropRequest {
    pub node_id: u32,
    pub window: Rect,
    pub monitor: Rect,
    /// Only a frame that arrived after this may be used.
    pub not_before: Instant,
    pub reply: mpsc::Sender<Result<Frame, CropError>>,
}

enum Command {
    Crop(CropRequest),
    Quit,
}

/// Whether a frame that arrived at `arrived` may serve a crop that must not predate `not_before`.
pub fn fresh_enough(arrived: Instant, not_before: Instant) -> bool {
    arrived > not_before
}

/// Facts the session thread shares with the rest of the helper.
struct Shared {
    /// False once the thread has left its loop: nothing will answer a crop any more.
    alive: AtomicBool,
    /// True once a stream went to `Error` or `Unconnected` on its own: the user stopped sharing
    /// from GNOME's indicator, or the compositor ended the session.
    stopped: AtomicBool,
}

/// A running session thread. Dropping it stops the thread and waits for it.
pub struct Running {
    commands: pw::channel::Sender<Command>,
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Running {
    /// A handle to ask for crops with, which can be used without holding whatever owns `self`.
    pub fn handle(&self) -> CropHandle {
        CropHandle { commands: self.commands.clone(), shared: Arc::clone(&self.shared) }
    }

    /// Whether the screen share ended without being asked to (see [`Shared::stopped`]), or the
    /// thread is gone.
    pub fn ended(&self) -> bool {
        self.shared.stopped.load(Ordering::SeqCst) || !self.shared.alive.load(Ordering::SeqCst)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Quit);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Asks the session thread for crops.
#[derive(Clone)]
pub struct CropHandle {
    commands: pw::channel::Sender<Command>,
    shared: Arc<Shared>,
}

impl CropHandle {
    /// Whether the session thread is still running.
    pub fn alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }

    /// Ask for a crop and wait up to `timeout` for it. `None` on timeout, or at once when the thread
    /// is gone (a PipeWire channel accepts messages after its loop has ended, so that is checked
    /// here rather than trusted to `send`).
    pub fn crop(&self, node_id: u32, window: Rect, monitor: Rect, not_before: Instant, timeout: Duration) -> Option<Result<Frame, CropError>> {
        if !self.shared.alive.load(Ordering::SeqCst) {
            return None;
        }
        let (reply, answer) = mpsc::channel();
        self.commands.send(Command::Crop(CropRequest { node_id, window, monitor, not_before, reply })).ok()?;
        answer.recv_timeout(timeout).ok()
    }
}

/// The negotiated layout of one stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Layout {
    width: u32,
    height: u32,
}

/// One stream's state, touched only on the session thread.
struct Held {
    node_id: u32,
    layout: Option<Layout>,
    /// The latest usable buffer, dequeued and not yet given back. Null when there is none.
    buffer: *mut pw::sys::pw_buffer,
    /// When `buffer` arrived.
    arrived: Option<Instant>,
    /// Set when the format changed after `buffer` arrived: its bytes follow the old layout, so it is
    /// not read until a buffer of the new one replaces it.
    stale: bool,
    /// Crops that found no fresh enough frame; served when one arrives.
    waiting: Vec<CropRequest>,
}

/// The image bytes of a buffer and their stride, if the buffer is usable.
///
/// # Safety
/// `buffer` must be a buffer dequeued from a stream connected with `MAP_BUFFERS` and not yet
/// queued back; the slice is only valid until it is.
unsafe fn image_of<'a>(buffer: *mut pw::sys::pw_buffer, layout: Layout) -> Option<(&'a [u8], usize)> {
    if buffer.is_null() {
        return None;
    }
    // SAFETY: the caller's contract; every pointer is checked for null before it is followed.
    unsafe {
        let spa_buffer = (*buffer).buffer;
        if spa_buffer.is_null() || (*spa_buffer).n_datas < 1 || (*spa_buffer).datas.is_null() {
            return None;
        }
        let data = &*(*spa_buffer).datas;
        // Only memory this process has mapped; a DmaBuf is never offered (no modifiers) but is refused.
        if data.type_ != spa::sys::SPA_DATA_MemPtr && data.type_ != spa::sys::SPA_DATA_MemFd {
            return None;
        }
        if data.data.is_null() || data.chunk.is_null() {
            return None;
        }
        let chunk = &*data.chunk;
        if chunk.flags & spa::sys::SPA_CHUNK_FLAG_CORRUPTED as i32 != 0 || chunk.stride <= 0 {
            return None;
        }
        let stride = chunk.stride as usize;
        let needed = stride.checked_mul(layout.height as usize)?;
        let offset = chunk.offset as usize;
        if offset > data.maxsize as usize {
            return None;
        }
        let available = (chunk.size as usize).min(data.maxsize as usize - offset);
        if available < needed {
            return None;
        }
        let bytes = std::slice::from_raw_parts((data.data as *const u8).add(offset), available);
        Some((bytes, stride))
    }
}

/// Serve a crop from the held buffer, or hand the request back when no fresh enough frame is held.
fn serve(held: &Held, request: CropRequest) -> Option<CropRequest> {
    let fresh = held.arrived.is_some_and(|arrived| fresh_enough(arrived, request.not_before));
    if held.buffer.is_null() || held.stale || !fresh {
        return Some(request);
    }
    let answer = (|| {
        let layout = held.layout.ok_or(CropError::NoImage)?;
        let rect: PixelRect =
            crop_rect(request.window, request.monitor, (layout.width, layout.height)).ok_or(CropError::OffMonitor)?;
        // SAFETY: `held.buffer` is dequeued and not given back while this runs (same thread).
        let (bytes, stride) = unsafe { image_of(held.buffer, layout) }.ok_or(CropError::NoImage)?;
        copy_window(bytes, stride, rect).ok_or(CropError::NoImage)
    })();
    let _ = request.reply.send(answer);
    None
}

/// The formats this module reads: 4 bytes a pixel, blue first. Anything else is not offered.
fn format_params() -> Vec<u8> {
    let object = pw::spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        pw::spa::pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pw::spa::pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pw::spa::pod::property!(FormatProperties::VideoFormat, Choice, Enum, Id, VideoFormat::BGRx, VideoFormat::BGRx, VideoFormat::BGRA),
        pw::spa::pod::property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle { width: 1920, height: 1080 },
            spa::utils::Rectangle { width: 1, height: 1 },
            spa::utils::Rectangle { width: 16384, height: 16384 }
        ),
        pw::spa::pod::property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: MAX_FRAMES_PER_SECOND, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction { num: MAX_FRAMES_PER_SECOND, denom: 1 }
        ),
    );
    pw::spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &pw::spa::pod::Value::Object(object))
        .map(|(cursor, _)| cursor.into_inner())
        .unwrap_or_default()
}

/// Start the session thread on the PipeWire socket the portal gave, with one stream per node.
/// `None` when the thread could not be started; a stream that fails to connect is left out.
pub fn spawn(pipewire: OwnedFd, node_ids: Vec<u32>) -> Option<Running> {
    let (commands, receiver) = pw::channel::channel::<Command>();
    let shared = Arc::new(Shared { alive: AtomicBool::new(true), stopped: AtomicBool::new(false) });
    let for_thread = Arc::clone(&shared);
    let thread = std::thread::Builder::new()
        .name("reader-screencast".to_owned())
        .spawn(move || {
            crate::runtime::guard(|| run(pipewire, &node_ids, receiver, &for_thread));
            for_thread.alive.store(false, Ordering::SeqCst);
        })
        .ok()?;
    Some(Running { commands, shared, thread: Some(thread) })
}

type Connected = (Rc<RefCell<Held>>, pw::stream::StreamRc, pw::stream::StreamListener<()>);

fn run(pipewire: OwnedFd, node_ids: &[u32], receiver: pw::channel::Receiver<Command>, shared: &Arc<Shared>) {
    pw::init();
    let Ok(main_loop) = pw::main_loop::MainLoopRc::new(None) else { return };
    let Ok(context) = pw::context::ContextRc::new(&main_loop, None) else { return };
    let Ok(core) = context.connect_fd_rc(pipewire, None) else { return };

    let format = format_params();
    // Only streams that connected are kept, each with its own state: a crop for a node that never
    // connected is answered `NoStream` at once instead of waiting out its timeout.
    let mut connected: Vec<Connected> = Vec::new();

    for node_id in node_ids {
        let state = Rc::new(RefCell::new(Held {
            node_id: *node_id,
            layout: None,
            buffer: std::ptr::null_mut(),
            arrived: None,
            stale: false,
            waiting: Vec::new(),
        }));
        let Ok(stream) = pw::stream::StreamRc::new(
            core.clone(),
            "clave-reader",
            pw::properties::properties! {
                *pw::keys::MEDIA_TYPE => "Video",
                *pw::keys::MEDIA_CATEGORY => "Capture",
                *pw::keys::MEDIA_ROLE => "Screen",
            },
        ) else {
            continue;
        };
        let on_param = Rc::clone(&state);
        let on_process = Rc::clone(&state);
        let on_remove = Rc::clone(&state);
        let on_state = Arc::clone(shared);
        let listener = stream
            .add_local_listener_with_user_data(())
            .state_changed(move |_, _, _, new| {
                // Reached only while the loop runs, so never from our own quit: a stream that ends
                // now was ended by the user or the compositor.
                if matches!(new, StreamState::Error(_) | StreamState::Unconnected) {
                    on_state.stopped.store(true, Ordering::SeqCst);
                }
            })
            .param_changed(move |_, _, id, param| {
                if id != spa::param::ParamType::Format.as_raw() {
                    return;
                }
                // The held buffer is NOT given back here. A format change (or the stream going away,
                // which arrives as a cleared format) is followed by PipeWire removing the buffers,
                // and queueing one it is tearing down crashed the helper (2026-09-23, gdb: inside
                // pw_stream_queue_buffer from here). `remove_buffer` forgets it instead; until then
                // it is stale, because its bytes follow the old layout.
                let mut held = on_param.borrow_mut();
                held.stale = !held.buffer.is_null();
                held.layout = None;
                let Some(param) = param else { return };
                let mut info = VideoInfoRaw::new();
                if info.parse(param).is_err() || !matches!(info.format(), VideoFormat::BGRx | VideoFormat::BGRA) {
                    return;
                }
                held.layout = Some(Layout { width: info.size().width, height: info.size().height });
            })
            .remove_buffer(move |_, _, removed| {
                let mut held = on_remove.borrow_mut();
                if held.buffer == removed {
                    held.buffer = std::ptr::null_mut();
                    held.arrived = None;
                    held.stale = false;
                }
            })
            .process(move |stream, _| {
                // SAFETY: a plain dequeue; the pointer is checked before use.
                let newest = unsafe { stream.dequeue_raw_buffer() };
                if newest.is_null() {
                    return;
                }
                let mut held = on_process.borrow_mut();
                // A new frame replaces the held one only if it can be read; otherwise it goes straight
                // back, and the last good frame stays (Task 3 review).
                // SAFETY: `newest` was just dequeued from this stream.
                let usable = held.layout.is_some_and(|layout| unsafe { image_of(newest, layout) }.is_some());
                if !usable {
                    // SAFETY: dequeued from this stream just above and not given back.
                    unsafe { stream.queue_raw_buffer(newest) };
                    return;
                }
                if !held.buffer.is_null() {
                    // SAFETY: the previous buffer, dequeued from this stream and not yet given back.
                    unsafe { stream.queue_raw_buffer(held.buffer) };
                }
                held.buffer = newest;
                held.arrived = Some(Instant::now());
                held.stale = false;
                let waiting = std::mem::take(&mut held.waiting);
                for request in waiting {
                    if let Some(request) = serve(&held, request) {
                        held.waiting.push(request);
                    }
                }
            })
            .register();
        let Ok(listener) = listener else { continue };
        let Some(pod) = Pod::from_bytes(&format) else { continue };
        let mut params = [pod];
        let connection = stream.connect(
            spa::utils::Direction::Input,
            Some(*node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        );
        if connection.is_ok() {
            connected.push((state, stream, listener));
        }
    }

    let quit_loop = main_loop.clone();
    let states: Vec<Rc<RefCell<Held>>> = connected.iter().map(|(state, _, _)| Rc::clone(state)).collect();
    let _attached = receiver.attach(main_loop.loop_(), move |command| match command {
        Command::Quit => quit_loop.quit(),
        Command::Crop(request) => {
            let Some(state) = states.iter().find(|state| state.borrow().node_id == request.node_id) else {
                let _ = request.reply.send(Err(CropError::NoStream));
                return;
            };
            let mut held = state.borrow_mut();
            if let Some(request) = serve(&held, request) {
                held.waiting.push(request);
            }
        }
    });
    main_loop.run();

    // Give every held buffer back while the streams still exist, then let them go.
    for (state, stream, _) in &connected {
        let mut held = state.borrow_mut();
        if !held.buffer.is_null() {
            // SAFETY: dequeued from this stream and not yet given back.
            unsafe { stream.queue_raw_buffer(held.buffer) };
            held.buffer = std::ptr::null_mut();
        }
    }
    for (_, stream, _) in &connected {
        let _ = stream.disconnect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_frame_newer_than_the_last_change_is_fresh() {
        let change = Instant::now();
        assert!(fresh_enough(change + Duration::from_millis(1), change));
        assert!(!fresh_enough(change, change), "a frame from the very moment of the change may show either side");
        assert!(!fresh_enough(change - Duration::from_millis(1), change));
    }
}
