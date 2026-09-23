//! Greyscale conversion and Windows.Media.Ocr text recognition.
//!
//! Windows ships one recogniser per installed language pack and each reads one language, where
//! Vision takes a preference list. English is asked for first, as on macOS; failing that any other
//! English pack, and failing that the user's own profile languages, which is what Windows itself
//! would use. Latin-script packs read each other's text well; accents are the known weak spot.

use std::sync::Mutex;

use ::windows::Globalization::Language;
use ::windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use ::windows::Media::Ocr::OcrEngine;
use ::windows::Security::Cryptography::CryptographicBuffer;
use ::windows::core::HSTRING;

use crate::frame::Frame;
use crate::text::Line;

/// Tried in this order before falling back to the user's profile languages.
const PREFERRED: [&str; 2] = ["en-US", "pt-BR"];

/// One engine for the whole helper. Creating one loads its language model, and that is the cost the
/// start-up warm-up pays on the main thread before `ready`; the worker thread then reads with this
/// same engine. `OcrEngine` is agile, so any thread may use it, and the lock keeps one recognition at a
/// time, which the worker's own queue does anyway. An engine that could not be created is not
/// remembered as `None` for good: the next recognition tries again.
static ENGINE: Mutex<Option<OcrEngine>> = Mutex::new(None);

fn create_engine() -> Option<OcrEngine> {
    let available = |tag: &str| {
        Language::CreateLanguage(&HSTRING::from(tag))
            .ok()
            .filter(|language| OcrEngine::IsLanguageSupported(language).unwrap_or(false))
    };
    let any_english = || {
        OcrEngine::AvailableRecognizerLanguages().ok()?.into_iter().find(|language| {
            language.LanguageTag().map(|tag| tag.to_string().to_ascii_lowercase().starts_with("en")).unwrap_or(false)
        })
    };
    let chosen = PREFERRED.iter().find_map(|tag| available(tag)).or_else(any_english);
    match chosen {
        Some(language) => OcrEngine::TryCreateFromLanguage(&language).ok(),
        None => OcrEngine::TryCreateFromUserProfileLanguages().ok(),
    }
}

/// The capture as 8-bit grey, tightly packed, at most `OcrEngine::MaxImageDimension` on its long
/// side (the recogniser refuses anything larger). Returns the bytes and their width and height.
///
/// The frame is BGRA, as Windows.Graphics.Capture delivers it. Rec. 601 luma, in integers.
pub fn to_greyscale(frame: &Frame) -> Option<(Vec<u8>, usize, usize)> {
    if frame.width == 0 || frame.height == 0 || frame.bytes_per_pixel < 3 {
        return None;
    }
    let limit = OcrEngine::MaxImageDimension().ok().filter(|&d| d > 0).unwrap_or(2600) as usize;
    // Whole-pixel steps, so every output pixel is one source pixel: cheap, and it is only needed for
    // windows wider than the recogniser's limit, which is rare.
    let step = frame.width.max(frame.height).div_ceil(limit).max(1);
    let (width, height) = (frame.width.div_ceil(step), frame.height.div_ceil(step));
    let mut grey = Vec::with_capacity(width * height);
    for y in 0..height {
        let row = y * step * frame.bytes_per_row;
        for x in 0..width {
            let at = row + x * step * frame.bytes_per_pixel;
            let pixel = frame.data.get(at..at + 3)?;
            let (b, g, r) = (u32::from(pixel[0]), u32::from(pixel[1]), u32::from(pixel[2]));
            grey.push(((299 * r + 587 * g + 114 * b) / 1000) as u8);
        }
    }
    Some((grey, width, height))
}

/// A greyscale image with a few dark bars on a light field, for the warm-up. Nothing depends on
/// what, if anything, is recognised in it.
pub fn synthetic_grey_image(width: usize, height: usize) -> Vec<u8> {
    let mut data = vec![0xf0u8; width * height];
    for y in 0..height {
        for x in 0..width {
            if (y / 8) % 3 == 0 && (x % 40) < 28 {
                data[y * width + x] = 0x20;
            }
        }
    }
    data
}

/// Recognise the text of a tightly packed 8-bit grey image, one [`Line`] per recognised line.
///
/// Windows reports word boxes in pixels from the top-left, so the only conversion is to the 0..1
/// fractions the rest of the crate uses; a line's box is the union of its words'.
pub fn recognise_grey(grey: &[u8], width: usize, height: usize) -> Result<Vec<Line>, ()> {
    if width == 0 || height == 0 || grey.len() < width * height {
        return Err(());
    }
    let buffer = CryptographicBuffer::CreateFromByteArray(&grey[..width * height]).map_err(|_| ())?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Gray8, width as i32, height as i32)
        .map_err(|_| ())?;
    let result = {
        // A panic while the lock was held leaves no half-made engine behind, so a poisoned lock is
        // simply taken back.
        let mut slot = ENGINE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = create_engine();
        }
        let engine = slot.as_ref().ok_or(())?;
        engine.RecognizeAsync(&bitmap).map_err(|_| ())?.join().map_err(|_| ())?
    };
    let _ = bitmap.Close();

    let (w, h) = (width as f64, height as f64);
    let mut lines = Vec::new();
    for line in result.Lines().map_err(|_| ())? {
        let text = line.Text().map_err(|_| ())?.to_string();
        let (mut left, mut top, mut right, mut bottom) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for word in line.Words().map_err(|_| ())? {
            let Ok(rect) = word.BoundingRect() else { continue };
            left = left.min(f64::from(rect.X));
            top = top.min(f64::from(rect.Y));
            right = right.max(f64::from(rect.X + rect.Width));
            bottom = bottom.max(f64::from(rect.Y + rect.Height));
        }
        if text.is_empty() || left > right || top > bottom {
            continue;
        }
        lines.push(Line { text, x: left / w, right: right / w, top: top / h, bottom: bottom / h });
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bgra(width: usize, height: usize, pixel: [u8; 4]) -> Frame {
        let data = pixel.repeat(width * height);
        Frame { width, height, bytes_per_row: width * 4, bytes_per_pixel: 4, data }
    }

    #[test]
    fn greyscale_reads_the_channels_in_bgra_order() {
        // Pure red and pure blue differ sharply in luma, so a swapped channel order would show.
        let (red, _, _) = to_greyscale(&bgra(2, 2, [0, 0, 255, 255])).expect("a frame");
        let (blue, _, _) = to_greyscale(&bgra(2, 2, [255, 0, 0, 255])).expect("a frame");
        assert_eq!(red[0], 76);
        assert_eq!(blue[0], 29);
    }

    #[test]
    fn greyscale_keeps_the_size_of_an_ordinary_window() {
        let (grey, width, height) = to_greyscale(&bgra(1200, 800, [200, 200, 200, 255])).expect("a frame");
        assert_eq!((width, height), (1200, 800));
        assert_eq!(grey.len(), 1200 * 800);
    }

    #[test]
    fn an_empty_frame_has_no_greyscale() {
        assert!(to_greyscale(&bgra(0, 0, [0, 0, 0, 0])).is_none());
    }
}
