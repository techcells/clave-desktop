//! From a whole monitor's pixels to the focused window's: the geometry and the copy.
//!
//! The ScreenCast portal gives the whole monitor, and the Linux reader keeps only the focused window
//! (design 4.4, the owner's decision of 2026-09-23). Both rectangles the extension reports, the
//! window's frame and the monitor's, are in the stage's logical layout; the stream is in device
//! pixels. The factor between them is the stream's size over the monitor's, which is right whether or
//! not Mutter scales the framebuffer (it is the monitor scale on scaled Wayland, and 1 on Xorg and
//! on Wayland without `scale-monitor-framebuffer`, where the layout is already in pixels).
//!
//! Nothing here touches PipeWire: the copy takes a byte slice and a stride, so every edge is tested
//! on any machine.

use super::extension::Rect;
use crate::frame::Frame;

/// The bytes of one pixel in every format the stream accepts (BGRx and BGRA).
pub const BYTES_PER_PIXEL: usize = 4;

/// A rectangle of whole pixels inside the stream's image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
}

/// The part of the stream's image the window covers, or `None` when it covers none of it (a window
/// on another monitor, or entirely off-screen), which the capture answers as a vanished window.
///
/// The edges are rounded outwards, so a fractional scale never shaves a line of text off the window,
/// and then clipped to the image, so a window partly off the monitor keeps its visible part.
pub fn crop_rect(window: Rect, monitor: Rect, stream: (u32, u32)) -> Option<PixelRect> {
    let (stream_width, stream_height) = (f64::from(stream.0), f64::from(stream.1));
    if stream.0 == 0 || stream.1 == 0 {
        return None;
    }
    let scale_x = stream_width / f64::from(monitor.width);
    let scale_y = stream_height / f64::from(monitor.height);
    let left = ((window.x - monitor.x) as f64 * scale_x).floor();
    let top = ((window.y - monitor.y) as f64 * scale_y).floor();
    let right = ((window.x - monitor.x + i64::from(window.width)) as f64 * scale_x).ceil();
    let bottom = ((window.y - monitor.y + i64::from(window.height)) as f64 * scale_y).ceil();
    let (left, top) = (left.max(0.0), top.max(0.0));
    let (right, bottom) = (right.min(stream_width), bottom.min(stream_height));
    if right <= left || bottom <= top {
        return None;
    }
    Some(PixelRect {
        x: left as usize,
        y: top as usize,
        width: (right - left) as usize,
        height: (bottom - top) as usize,
    })
}

/// Copy the window's rectangle out of the monitor's image into a frame of its own, row by row.
///
/// `stride` is the image's bytes per row. `None` when the image is too short for the rectangle, or
/// the stride too narrow for the rectangle's right edge: a half-copied window is never passed on.
pub fn copy_window(image: &[u8], stride: usize, rect: PixelRect) -> Option<Frame> {
    let row_bytes = rect.width.checked_mul(BYTES_PER_PIXEL)?;
    let first_byte = rect.x.checked_mul(BYTES_PER_PIXEL)?;
    if first_byte.checked_add(row_bytes)? > stride {
        return None;
    }
    let mut data = Vec::with_capacity(row_bytes.checked_mul(rect.height)?);
    for row in rect.y..rect.y.checked_add(rect.height)? {
        let start = row.checked_mul(stride)?.checked_add(first_byte)?;
        data.extend_from_slice(image.get(start..start.checked_add(row_bytes)?)?);
    }
    Some(Frame { width: rect.width, height: rect.height, bytes_per_row: row_bytes, bytes_per_pixel: BYTES_PER_PIXEL, data })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONITOR: Rect = Rect { x: 0, y: 0, width: 1440, height: 900 };
    const TERMINAL: Rect = Rect { x: 66, y: 32, width: 914, height: 577 };

    fn rect(x: i64, y: i64, width: u32, height: u32) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn at_scale_one_the_crop_is_the_frame() {
        assert_eq!(crop_rect(TERMINAL, MONITOR, (1440, 900)), Some(PixelRect { x: 66, y: 32, width: 914, height: 577 }));
    }

    #[test]
    fn a_scaled_framebuffer_doubles_the_crop() {
        assert_eq!(crop_rect(TERMINAL, MONITOR, (2880, 1800)), Some(PixelRect { x: 132, y: 64, width: 1828, height: 1154 }));
    }

    #[test]
    fn a_physical_layout_is_already_in_pixels_whatever_the_monitor_scale() {
        // Xorg, or Wayland without framebuffer scaling, at scale 2: the monitor is 2880 wide in the
        // layout AND in the stream, so the factor is 1, not 2.
        let monitor = rect(0, 0, 2880, 1800);
        assert_eq!(crop_rect(rect(132, 64, 1828, 1154), monitor, (2880, 1800)), Some(PixelRect { x: 132, y: 64, width: 1828, height: 1154 }));
    }

    #[test]
    fn fractional_scales_round_outwards() {
        // 1.25: 66 * 1.25 = 82.5 -> 82; (66 + 914) * 1.25 = 1225 exactly; 32 * 1.25 = 40; 609 * 1.25 = 761.25 -> 762.
        assert_eq!(crop_rect(TERMINAL, MONITOR, (1800, 1125)), Some(PixelRect { x: 82, y: 40, width: 1143, height: 722 }));
        // 1.5: 99 .. 1470, 48 .. 914 (913.5 up).
        assert_eq!(crop_rect(TERMINAL, MONITOR, (2160, 1350)), Some(PixelRect { x: 99, y: 48, width: 1371, height: 866 }));
    }

    #[test]
    fn a_right_or_bottom_edge_between_pixels_is_rounded_up() {
        // 1.25: 1 -> 1.25 (floor 1), 2 -> 2.5 (ceil 3): two pixels, not one.
        assert_eq!(crop_rect(rect(1, 1, 1, 1), MONITOR, (1800, 1125)), Some(PixelRect { x: 1, y: 1, width: 2, height: 2 }));
    }

    #[test]
    fn a_second_monitor_is_measured_from_its_own_origin() {
        let right = rect(1440, 0, 1920, 1080);
        assert_eq!(crop_rect(rect(1500, 100, 800, 600), right, (1920, 1080)), Some(PixelRect { x: 60, y: 100, width: 800, height: 600 }));
        let above = rect(0, -1080, 1920, 1080);
        assert_eq!(crop_rect(rect(10, -1000, 800, 600), above, (1920, 1080)), Some(PixelRect { x: 10, y: 80, width: 800, height: 600 }));
    }

    #[test]
    fn a_window_partly_off_the_monitor_keeps_its_visible_part() {
        assert_eq!(crop_rect(rect(-40, -8, 800, 600), MONITOR, (1440, 900)), Some(PixelRect { x: 0, y: 0, width: 760, height: 592 }));
        assert_eq!(crop_rect(rect(1000, 500, 800, 600), MONITOR, (1440, 900)), Some(PixelRect { x: 1000, y: 500, width: 440, height: 400 }));
    }

    #[test]
    fn a_window_off_this_monitor_has_no_crop() {
        assert_eq!(crop_rect(rect(1440, 0, 800, 600), MONITOR, (1440, 900)), None, "just past the right edge");
        assert_eq!(crop_rect(rect(-800, 0, 800, 600), MONITOR, (1440, 900)), None, "just past the left edge");
        assert_eq!(crop_rect(rect(0, 900, 800, 600), MONITOR, (1440, 900)), None, "just below");
        assert_eq!(crop_rect(TERMINAL, MONITOR, (0, 900)), None, "a stream with no pixels");
    }

    /// A 6 x 3 image whose every byte says where it is: row * 100 + column * 4 + channel.
    fn image(stride: usize) -> Vec<u8> {
        let mut bytes = vec![255u8; stride * 3];
        for row in 0..3 {
            for column in 0..6 {
                for channel in 0..4 {
                    bytes[row * stride + column * 4 + channel] = (row * 100 + column * 4 + channel) as u8;
                }
            }
        }
        bytes
    }

    #[test]
    fn the_copy_takes_exactly_the_rectangle_row_by_row() {
        let frame = copy_window(&image(24), 24, PixelRect { x: 1, y: 1, width: 2, height: 2 }).unwrap();
        assert_eq!((frame.width, frame.height, frame.bytes_per_row, frame.bytes_per_pixel), (2, 2, 8, 4));
        assert_eq!(frame.data, vec![104, 105, 106, 107, 108, 109, 110, 111, 204, 205, 206, 207, 208, 209, 210, 211]);
    }

    #[test]
    fn a_padded_stride_is_skipped() {
        let frame = copy_window(&image(32), 32, PixelRect { x: 0, y: 2, width: 6, height: 1 }).unwrap();
        assert_eq!(frame.data.len(), 24);
        assert_eq!(frame.data[0], 200);
        assert_eq!(frame.data[23], 223);
    }

    #[test]
    fn a_rectangle_the_image_cannot_hold_is_not_copied() {
        let bytes = image(24);
        assert!(copy_window(&bytes, 24, PixelRect { x: 5, y: 0, width: 2, height: 1 }).is_none(), "past the right edge");
        assert!(copy_window(&bytes, 24, PixelRect { x: 0, y: 2, width: 1, height: 2 }).is_none(), "past the last row");
        assert!(copy_window(&bytes[..70], 24, PixelRect { x: 0, y: 2, width: 6, height: 1 }).is_none(), "a short buffer");
        assert!(copy_window(&bytes, 24, PixelRect { x: usize::MAX / 2, y: 0, width: 1, height: 1 }).is_none(), "overflow");
    }
}
