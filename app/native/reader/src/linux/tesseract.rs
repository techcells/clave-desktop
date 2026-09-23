//! Tesseract, through its C API: the few calls the reader needs, and the engine that holds them.
//!
//! A hand-written binding rather than a crate: a few calls of Tesseract 5's stable C API, and one
//! of Leptonica's, with no build-time code generation and nothing else pulled in. The engine is created once, with the
//! `tessdata_best` models loaded as `por+eng` (Portuguese first: with English first the accents were
//! lost, measured 2026-09-23), and used by one thread at a time.
//!
//! Tesseract must run on one thread (`OMP_THREAD_LIMIT=1`): with all threads, one read under load
//! took 15 s. OpenMP reads that variable when the library loads, before `main`, so `prologue`
//! restarts the helper with it set when it is missing (see `mod.rs`).

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::Path;

use crate::text::Line;

#[repr(C)]
struct TessBaseApi {
    _private: [u8; 0],
}
#[repr(C)]
struct TessResultIterator {
    _private: [u8; 0],
}
#[repr(C)]
struct TessPageIterator {
    _private: [u8; 0],
}

/// `PSM_AUTO`: page segmentation with no orientation detection.
const PSM_AUTO: c_int = 3;
/// `RIL_TEXTLINE`.
const LEVEL_LINE: c_int = 2;
/// The resolution the accuracy test told Tesseract its images had.
const SOURCE_DPI: c_int = 144;

#[link(name = "tesseract")]
unsafe extern "C" {
    fn TessBaseAPICreate() -> *mut TessBaseApi;
    fn TessBaseAPIDelete(handle: *mut TessBaseApi);
    fn TessBaseAPIInit3(handle: *mut TessBaseApi, datapath: *const c_char, language: *const c_char) -> c_int;
    fn TessBaseAPISetPageSegMode(handle: *mut TessBaseApi, mode: c_int);
    fn TessBaseAPISetVariable(handle: *mut TessBaseApi, name: *const c_char, value: *const c_char) -> c_int;
    fn TessBaseAPISetImage(handle: *mut TessBaseApi, data: *const u8, width: c_int, height: c_int, bytes_per_pixel: c_int, bytes_per_line: c_int);
    fn TessBaseAPISetSourceResolution(handle: *mut TessBaseApi, ppi: c_int);
    fn TessBaseAPIRecognize(handle: *mut TessBaseApi, monitor: *mut c_void) -> c_int;
    fn TessBaseAPIGetIterator(handle: *mut TessBaseApi) -> *mut TessResultIterator;
    fn TessBaseAPIClear(handle: *mut TessBaseApi);
    fn TessResultIteratorDelete(iterator: *mut TessResultIterator);
    fn TessResultIteratorNext(iterator: *mut TessResultIterator, level: c_int) -> c_int;
    fn TessResultIteratorGetUTF8Text(iterator: *const TessResultIterator, level: c_int) -> *mut c_char;
    fn TessResultIteratorGetPageIterator(iterator: *mut TessResultIterator) -> *mut TessPageIterator;
    fn TessPageIteratorBoundingBox(iterator: *const TessPageIterator, level: c_int, left: *mut c_int, top: *mut c_int, right: *mut c_int, bottom: *mut c_int) -> c_int;
    fn TessDeleteText(text: *const c_char);
}

/// Leptonica's `L_SEVERITY_NONE`: print no messages.
const LEPTONICA_SILENT: c_int = 6;

#[link(name = "lept")]
unsafe extern "C" {
    fn setMsgSeverity(severity: c_int) -> c_int;
}

/// One Tesseract instance with the models loaded.
pub struct Engine {
    handle: *mut TessBaseApi,
}

// SAFETY: a TessBaseAPI may be moved between threads; it is only ever used by one at a time, which
// the Mutex that holds the engine guarantees.
unsafe impl Send for Engine {}

impl Engine {
    /// Load `languages` (e.g. "por+eng") from `tessdata`. `None` when Tesseract cannot.
    pub fn new(tessdata: &Path, languages: &str) -> Option<Engine> {
        let datapath = CString::new(tessdata.to_str()?).ok()?;
        let languages = CString::new(languages).ok()?;
        // SAFETY: plain calls; the handle is checked and deleted on failure.
        unsafe {
            let handle = TessBaseAPICreate();
            if handle.is_null() {
                return None;
            }
            // Tesseract's own messages ("Estimating resolution", and at exit "WARNING! LEAK!" with the
            // model paths) go to stderr unless told otherwise, and the helper's stderr carries fixed
            // codes and nothing else. `debug_file` is a global setting, so it holds for every
            // message, including the ones printed while the process exits.
            // If Tesseract cannot be silenced, it is not used: its messages would carry model paths.
            if TessBaseAPISetVariable(handle, c"debug_file".as_ptr(), c"/dev/null".as_ptr()) == 0 {
                TessBaseAPIDelete(handle);
                return None;
            }
            // Leptonica, which Tesseract reads images with, prints its own "Error in ..." lines and
            // does not go through `debug_file`.
            setMsgSeverity(LEPTONICA_SILENT);
            if TessBaseAPIInit3(handle, datapath.as_ptr(), languages.as_ptr()) != 0 {
                TessBaseAPIDelete(handle);
                return None;
            }
            TessBaseAPISetPageSegMode(handle, PSM_AUTO);
            Some(Engine { handle })
        }
    }

    /// Recognise a grey image (one byte a pixel, rows packed): one [`Line`] per text line, with its
    /// box as fractions of the image from the top-left. `Err(())` when Tesseract fails; an image
    /// with no text is `Ok` and empty.
    pub fn recognise(&mut self, grey: &[u8], width: usize, height: usize) -> Result<Vec<Line>, ()> {
        let (w, h) = (c_int::try_from(width).map_err(|_| ())?, c_int::try_from(height).map_err(|_| ())?);
        if width == 0 || height == 0 || grey.len() < width * height {
            return Err(());
        }
        let mut lines = Vec::new();
        // SAFETY: `grey` outlives the recognition (the result is cleared before returning); every
        // pointer Tesseract hands back is checked and freed with its own call.
        unsafe {
            TessBaseAPISetImage(self.handle, grey.as_ptr(), w, h, 1, w);
            TessBaseAPISetSourceResolution(self.handle, SOURCE_DPI);
            if TessBaseAPIRecognize(self.handle, std::ptr::null_mut()) != 0 {
                TessBaseAPIClear(self.handle);
                return Err(());
            }
            let iterator = TessBaseAPIGetIterator(self.handle);
            if !iterator.is_null() {
                loop {
                    let text = TessResultIteratorGetUTF8Text(iterator, LEVEL_LINE);
                    let (mut left, mut top, mut right, mut bottom) = (0, 0, 0, 0);
                    let boxed = TessPageIteratorBoundingBox(
                        TessResultIteratorGetPageIterator(iterator),
                        LEVEL_LINE,
                        &mut left,
                        &mut top,
                        &mut right,
                        &mut bottom,
                    ) != 0;
                    if !text.is_null() {
                        let line = CStr::from_ptr(text).to_string_lossy().trim().to_owned();
                        TessDeleteText(text);
                        if boxed && !line.is_empty() {
                            let (fw, fh) = (width as f64, height as f64);
                            lines.push(Line {
                                text: line,
                                x: f64::from(left) / fw,
                                right: f64::from(right) / fw,
                                top: f64::from(top) / fh,
                                bottom: f64::from(bottom) / fh,
                            });
                        }
                    }
                    if TessResultIteratorNext(iterator, LEVEL_LINE) == 0 {
                        break;
                    }
                }
                TessResultIteratorDelete(iterator);
            }
            TessBaseAPIClear(self.handle);
        }
        Ok(lines)
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: the handle came from TessBaseAPICreate and is deleted once.
        unsafe { TessBaseAPIDelete(self.handle) };
    }
}
