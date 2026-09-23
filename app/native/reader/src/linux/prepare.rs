//! Getting a captured window ready for Tesseract, exactly as the measurement that passed did it.
//!
//! The Linux accuracy test (`app/reader-eval/linux/`, 2026-09-23) passed every threshold only with
//! this preparation: grayscale, dark themes inverted to dark-on-light, and windows captured at scale
//! 1 enlarged to twice their size with a Lanczos filter (at scale 2 they were not enlarged).
//!
//! The enlargement is `2 / scale`, between 1 and 2 (so 2x at scale 1, none at scale 2, and in
//! between for fractional scales, which the test did not measure), and never past
//! [`MAX_PREPARED_PIXELS`]: Tesseract's time grows with the pixels, and a maximised window enlarged
//! 2x would be 8 to 33 megapixels (Task 4 review). A window already over the limit is not enlarged,
//! and never shrunk. It prepared the images with Pillow, so this
//! module does what Pillow does, down to its arithmetic: the same luma weights and rounding, and the
//! same fixed-point Lanczos resampling, so the numbers the test measured are the numbers the reader
//! gets. The tests hold it to Pillow's own output.

use crate::frame::Frame;

/// The most pixels an enlarged image may have: a little over the test pages (1160 x 640 enlarged 2x
/// is 2.97 megapixels, recognised in a median 820 ms on one thread in the VM).
pub const MAX_PREPARED_PIXELS: f64 = 4_000_000.0;

/// The mean grey level below which an image counts as a dark theme and is inverted.
pub const DARK_BELOW_MEAN: f64 = 128.0;

/// A grayscale image, one byte a pixel, rows packed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grey {
    pub data: Vec<u8>,
    pub width: usize,
    pub height: usize,
}

/// Pillow's luma: `L = R * 299/1000 + G * 587/1000 + B * 114/1000`, in its fixed-point form.
fn luma(red: u8, green: u8, blue: u8) -> u8 {
    ((u32::from(red) * 19_595 + u32::from(green) * 38_470 + u32::from(blue) * 7_471 + 0x8000) >> 16) as u8
}

/// The grey image of a BGRx or BGRA frame (blue first, as the capture negotiates). `None` for a
/// frame that is not 4 bytes a pixel or is shorter than its own geometry.
pub fn grey_of(frame: &Frame) -> Option<Grey> {
    if frame.bytes_per_pixel != 4 || frame.width == 0 || frame.height == 0 {
        return None;
    }
    let mut data = Vec::with_capacity(frame.width.checked_mul(frame.height)?);
    for row in 0..frame.height {
        let start = row.checked_mul(frame.bytes_per_row)?;
        let pixels = frame.data.get(start..start.checked_add(frame.width.checked_mul(4)?)?)?;
        data.extend(pixels.chunks_exact(4).map(|pixel| luma(pixel[2], pixel[1], pixel[0])));
    }
    Some(Grey { data, width: frame.width, height: frame.height })
}

/// The mean grey level.
pub fn mean(grey: &Grey) -> f64 {
    if grey.data.is_empty() {
        return 0.0;
    }
    grey.data.iter().map(|&value| f64::from(value)).sum::<f64>() / grey.data.len() as f64
}

/// Turn a dark theme into dark text on a light background.
pub fn invert(grey: &mut Grey) {
    for value in &mut grey.data {
        *value = 255 - *value;
    }
}

fn sinc(x: f64) -> f64 {
    if x == 0.0 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) }
}

fn lanczos(x: f64) -> f64 {
    if (-3.0..3.0).contains(&x) { sinc(x) * sinc(x / 3.0) } else { 0.0 }
}

/// Pillow's `PRECISION_BITS` for 8-bit images (32 - 8 - 2).
const PRECISION_BITS: u32 = 22;

/// For each output pixel along one axis: the first input pixel it reads and its fixed-point weights.
/// Pillow's `precompute_coeffs` for Lanczos, and its normalisation to integers.
fn coefficients(input: usize, output: usize) -> Vec<(usize, Vec<i64>)> {
    let scale = input as f64 / output as f64;
    let filter_scale = scale.max(1.0);
    let support = 3.0 * filter_scale;
    (0..output)
        .map(|out| {
            let center = (out as f64 + 0.5) * scale;
            // `(int)` in C truncates toward zero, then Pillow clamps.
            let first = ((center - support + 0.5) as i64).max(0) as usize;
            let last = ((center + support + 0.5) as i64).min(input as i64) as usize;
            let weights: Vec<f64> = (first..last).map(|i| lanczos((i as f64 - center + 0.5) / filter_scale)).collect();
            let total: f64 = weights.iter().sum();
            let fixed = weights
                .iter()
                .map(|weight| {
                    let normalised = if total == 0.0 { 0.0 } else { weight / total };
                    let scaled = normalised * f64::from(1u32 << PRECISION_BITS);
                    (if normalised < 0.0 { scaled - 0.5 } else { scaled + 0.5 }) as i64
                })
                .collect();
            (first, fixed)
        })
        .collect()
}

fn clip8(value: i64) -> u8 {
    (value >> PRECISION_BITS).clamp(0, 255) as u8
}

/// How much to enlarge a `width` x `height` window captured at `scale` (see the module comment).
pub fn enlargement(width: usize, height: usize, scale: f64) -> f64 {
    let wanted = if scale.is_finite() && scale > 0.0 { (2.0 / scale).clamp(1.0, 2.0) } else { 1.0 };
    let pixels = (width as f64) * (height as f64);
    if pixels * wanted * wanted <= MAX_PREPARED_PIXELS {
        wanted
    } else {
        (MAX_PREPARED_PIXELS / pixels).sqrt().clamp(1.0, wanted)
    }
}

/// Enlarge to twice the width and height (see [`resize`]). The tests hold it to Pillow's output.
#[cfg(test)]
pub fn enlarge_twice(grey: &Grey) -> Grey {
    resize(grey, grey.width * 2, grey.height * 2)
}

/// Resize with Pillow's Lanczos: horizontally first, then vertically.
pub fn resize(grey: &Grey, width: usize, height: usize) -> Grey {
    let across = coefficients(grey.width, width);
    let mut wide = vec![0u8; width * grey.height];
    for row in 0..grey.height {
        let source = &grey.data[row * grey.width..(row + 1) * grey.width];
        for (out, (first, weights)) in across.iter().enumerate() {
            let sum = weights.iter().enumerate().map(|(k, weight)| i64::from(source[first + k]) * weight).sum::<i64>();
            wide[row * width + out] = clip8(sum + (1 << (PRECISION_BITS - 1)));
        }
    }
    let down = coefficients(grey.height, height);
    let mut data = vec![0u8; width * height];
    for (out, (first, weights)) in down.iter().enumerate() {
        for column in 0..width {
            let sum = weights
                .iter()
                .enumerate()
                .map(|(k, weight)| i64::from(wide[(first + k) * width + column]) * weight)
                .sum::<i64>();
            data[out * width + column] = clip8(sum + (1 << (PRECISION_BITS - 1)));
        }
    }
    Grey { data, width, height }
}

/// The whole preparation: grey, inverted when dark, enlarged by [`enlargement`]. Returns the image
/// and the factor it was enlarged by.
pub fn prepare(frame: &Frame, scale: f64) -> Option<(Grey, f64)> {
    let mut grey = grey_of(frame)?;
    if mean(&grey) < DARK_BELOW_MEAN {
        invert(&mut grey);
    }
    let factor = enlargement(grey.width, grey.height, scale);
    if factor <= 1.0 {
        return Some((grey, 1.0));
    }
    let width = ((grey.width as f64) * factor).round() as usize;
    let height = ((grey.height as f64) * factor).round() as usize;
    Some((resize(&grey, width, height), factor))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bgrx(pixels: &[(u8, u8, u8)], width: usize) -> Frame {
        let data = pixels.iter().flat_map(|&(r, g, b)| [b, g, r, 0xff]).collect();
        Frame { width, height: pixels.len() / width, bytes_per_row: width * 4, bytes_per_pixel: 4, data }
    }

    #[test]
    fn grey_is_pillows_luma() {
        // Pillow, same pixels: Image.frombytes('RGB', ...).convert('L') == [76, 150, 29, 71].
        let frame = bgrx(&[(255, 0, 0), (0, 255, 0), (0, 0, 255), (123, 45, 67)], 4);
        assert_eq!(grey_of(&frame).unwrap().data, vec![76, 150, 29, 71]);
    }

    #[test]
    fn a_padded_row_is_read_to_its_width_only() {
        let mut frame = bgrx(&[(255, 255, 255), (0, 0, 0), (255, 255, 255), (0, 0, 0)], 2);
        // Pad each row with 4 bytes of junk.
        let rows: Vec<u8> = frame.data.chunks(8).flat_map(|row| row.iter().copied().chain([9, 9, 9, 9])).collect();
        frame.data = rows;
        frame.bytes_per_row = 12;
        assert_eq!(grey_of(&frame).unwrap().data, vec![255, 0, 255, 0]);
    }

    #[test]
    fn a_frame_that_is_not_four_bytes_a_pixel_or_too_short_is_refused() {
        let mut frame = bgrx(&[(1, 2, 3)], 1);
        frame.bytes_per_pixel = 3;
        assert!(grey_of(&frame).is_none());
        let mut frame = bgrx(&[(1, 2, 3), (1, 2, 3)], 2);
        frame.height = 2;
        assert!(grey_of(&frame).is_none());
    }

    #[test]
    fn enlarging_a_row_matches_pillow_exactly() {
        // Pillow: Image.frombytes('L', (8, 1), row).resize((16, 1), Image.LANCZOS).
        let row = Grey { data: vec![0, 0, 0, 255, 255, 0, 40, 200], width: 8, height: 1 };
        let big = enlarge_twice(&row);
        assert_eq!((big.width, big.height), (16, 2));
        assert_eq!(&big.data[..16], &[0, 2, 7, 0, 0, 52, 194, 255, 255, 192, 52, 0, 0, 92, 173, 219]);
    }

    #[test]
    fn enlarging_both_ways_matches_pillow_exactly() {
        // Pillow: a 2 x 8 image [10, 250] x 4 rows then [250, 10] x 4 rows, resized to 4 x 16.
        let grey = Grey { data: [[10u8, 250]; 4].concat().into_iter().chain([[250u8, 10]; 4].concat()).collect(), width: 2, height: 8 };
        let expected = [
            0, 66, 194, 255, 0, 66, 194, 255, 0, 66, 194, 255, 2, 67, 193, 253, 8, 70, 190, 247, 0, 58, 202, 255, 0, 53, 207,
            255, 54, 93, 167, 201, 201, 167, 93, 54, 255, 207, 53, 0, 255, 202, 58, 0, 247, 190, 70, 8, 253, 193, 67, 2, 255,
            194, 66, 0, 255, 194, 66, 0, 255, 194, 66, 0,
        ];
        assert_eq!(enlarge_twice(&grey).data, expected);
    }

    #[test]
    fn a_dark_theme_is_inverted_and_a_light_one_is_not() {
        let dark = bgrx(&[(20, 20, 20), (20, 20, 20), (230, 230, 230), (20, 20, 20)], 4);
        let (prepared, _) = prepare(&dark, 2.0).unwrap();
        assert_eq!(prepared.data, vec![235, 235, 25, 235]);
        let light = bgrx(&[(240, 240, 240), (240, 240, 240), (10, 10, 10), (240, 240, 240)], 4);
        let (prepared, _) = prepare(&light, 2.0).unwrap();
        assert_eq!(prepared.data, vec![240, 240, 10, 240]);
    }

    #[test]
    fn a_window_is_enlarged_to_about_two_pixels_a_point_and_no_more() {
        assert_eq!(enlargement(1160, 640, 1.0), 2.0, "the test pages at scale 1");
        assert_eq!(enlargement(1160, 640, 2.0), 1.0, "the test pages at scale 2");
        assert_eq!(enlargement(1160, 640, 1.25), 1.6);
        assert_eq!(enlargement(1160, 640, 3.0), 1.0, "never shrunk");
        assert_eq!(enlargement(100, 100, 0.5), 2.0, "never more than 2x, even below scale 1");
        assert_eq!(enlargement(100, 100, 0.0), 1.0, "a scale that makes no sense enlarges nothing");
        assert_eq!(enlargement(100, 100, f64::NAN), 1.0);
    }

    #[test]
    fn a_large_window_is_enlarged_only_up_to_the_limit_and_one_over_it_not_at_all() {
        let maximised = enlargement(1920, 1040, 1.0);
        assert!(maximised > 1.0 && maximised < 2.0, "{maximised}");
        assert!((1920.0 * 1040.0 * maximised * maximised) <= MAX_PREPARED_PIXELS + 1.0);
        assert_eq!(enlargement(3840, 2160, 1.0), 1.0, "a 4K window is already over the limit");
    }

    #[test]
    fn prepare_enlarges_by_the_factor_and_reports_it() {
        let frame = bgrx(&[(200, 200, 200); 6], 3);
        assert_eq!(prepare(&frame, 1.0).map(|(grey, factor)| (grey.width, grey.height, factor)), Some((6, 4, 2.0)));
        assert_eq!(prepare(&frame, 2.0).map(|(grey, factor)| (grey.width, grey.height, factor)), Some((3, 2, 1.0)));
        let frame = bgrx(&[(200, 200, 200); 100], 10);
        assert_eq!(prepare(&frame, 1.25).map(|(grey, factor)| (grey.width, grey.height, factor)), Some((16, 16, 1.6)));
    }
}
