//! Tesseract, through its C API: the few calls the reader needs, and the engine that holds them.
//!
//! A hand-written binding rather than a crate: a few calls of Tesseract 5's stable C API, and one
//! of Leptonica's, with no build-time code generation and nothing else pulled in. The library is
//! loaded at run time under the names the distributions give it (`library_names`), not linked. The engine is created once, with the
//! model `recognise.rs` names (the fast Portuguese one since 2026-09-24), and used by one thread at a time.
//!
//! Tesseract must run on one thread (`OMP_THREAD_LIMIT=1`): with all threads, one read under load
//! took 15 s. OpenMP reads that variable when the library loads (at the first `dlopen` here), and
//! `prologue` restarts the helper with it set when it is missing (see `mod.rs`).

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::Path;
use std::sync::OnceLock;

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

/// Leptonica's `L_SEVERITY_NONE`: print no messages.
const LEPTONICA_SILENT: c_int = 6;

// The dynamic loader, from the C library (glibc 2.34 and later has it in libc itself).
unsafe extern "C" {
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}
const RTLD_NOW: c_int = 2;

/// The file names Tesseract 5's library goes by, tried in this order: Debian and Ubuntu build it with
/// libtool (`libtesseract.so.5`), Fedora with CMake (`libtesseract.so.5.<minor>`, 5.5 on Fedora 44).
/// The C API the reader uses is the same across 5.x. Loaded at run time, not linked, so one reader
/// serves both packages (owner decision, 2026-09-23).
pub fn library_names() -> Vec<CString> {
    let mut names = vec![c"libtesseract.so.5".to_owned()];
    for minor in (0..=9).rev() {
        names.push(CString::new(format!("libtesseract.so.5.{minor}")).expect("no NUL in a library name"));
    }
    names
}

/// The first of `names` that `open` opens (a null answer is "not there").
fn open_first(names: &[CString], open: impl Fn(&CStr) -> *mut c_void) -> Option<*mut c_void> {
    names.iter().map(|name| open(name)).find(|handle| !handle.is_null())
}

/// The calls the reader makes, found in the loaded library. Leptonica's one call is found through
/// Tesseract's handle: `dlsym` on a handle also searches the libraries it depends on, so Leptonica's
/// own file name (`liblept.so.5` on Ubuntu, `libleptonica.so.6` on Fedora 44) never matters.
struct Api {
    create: unsafe extern "C" fn() -> *mut TessBaseApi,
    delete: unsafe extern "C" fn(*mut TessBaseApi),
    init3: unsafe extern "C" fn(*mut TessBaseApi, *const c_char, *const c_char) -> c_int,
    set_page_seg_mode: unsafe extern "C" fn(*mut TessBaseApi, c_int),
    set_variable: unsafe extern "C" fn(*mut TessBaseApi, *const c_char, *const c_char) -> c_int,
    set_image: unsafe extern "C" fn(*mut TessBaseApi, *const u8, c_int, c_int, c_int, c_int),
    set_source_resolution: unsafe extern "C" fn(*mut TessBaseApi, c_int),
    recognize: unsafe extern "C" fn(*mut TessBaseApi, *mut c_void) -> c_int,
    get_iterator: unsafe extern "C" fn(*mut TessBaseApi) -> *mut TessResultIterator,
    clear: unsafe extern "C" fn(*mut TessBaseApi),
    iterator_delete: unsafe extern "C" fn(*mut TessResultIterator),
    iterator_next: unsafe extern "C" fn(*mut TessResultIterator, c_int) -> c_int,
    iterator_text: unsafe extern "C" fn(*const TessResultIterator, c_int) -> *mut c_char,
    iterator_page: unsafe extern "C" fn(*mut TessResultIterator) -> *mut TessPageIterator,
    bounding_box: unsafe extern "C" fn(*const TessPageIterator, c_int, *mut c_int, *mut c_int, *mut c_int, *mut c_int) -> c_int,
    delete_text: unsafe extern "C" fn(*const c_char),
    set_msg_severity: unsafe extern "C" fn(c_int) -> c_int,
}

/// Every symbol `Api` needs, by name, in the order `resolve` asks for them.
pub const SYMBOLS: [&CStr; 17] = [
    c"TessBaseAPICreate", c"TessBaseAPIDelete", c"TessBaseAPIInit3", c"TessBaseAPISetPageSegMode", c"TessBaseAPISetVariable",
    c"TessBaseAPISetImage", c"TessBaseAPISetSourceResolution", c"TessBaseAPIRecognize", c"TessBaseAPIGetIterator", c"TessBaseAPIClear",
    c"TessResultIteratorDelete", c"TessResultIteratorNext", c"TessResultIteratorGetUTF8Text", c"TessResultIteratorGetPageIterator",
    c"TessPageIteratorBoundingBox", c"TessDeleteText", c"setMsgSeverity",
];

/// The `Api` from a symbol lookup, or `None` if any symbol is missing: a library without one of them is
/// not used at all.
fn resolve(lookup: impl Fn(&CStr) -> *mut c_void) -> Option<Api> {
    let mut found = [std::ptr::null_mut::<c_void>(); SYMBOLS.len()];
    for (slot, name) in found.iter_mut().zip(SYMBOLS) {
        *slot = lookup(name);
        if slot.is_null() {
            return None;
        }
    }
    // SAFETY: each pointer is the address of the C function of that name in Tesseract 5's (or
    // Leptonica's) C API, whose signatures are the ones declared in `Api`; none is null.
    unsafe {
        use std::mem::transmute as f;
        Some(Api {
            create: f(found[0]), delete: f(found[1]), init3: f(found[2]), set_page_seg_mode: f(found[3]), set_variable: f(found[4]),
            set_image: f(found[5]), set_source_resolution: f(found[6]), recognize: f(found[7]), get_iterator: f(found[8]), clear: f(found[9]),
            iterator_delete: f(found[10]), iterator_next: f(found[11]), iterator_text: f(found[12]), iterator_page: f(found[13]),
            bounding_box: f(found[14]), delete_text: f(found[15]), set_msg_severity: f(found[16]),
        })
    }
}

/// Tesseract, loaded once for the life of the process (the handle is never closed). `None` when no
/// library under `library_names` loads or one lacks a call the reader makes.
fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| {
        // SAFETY: dlopen and dlsym with NUL-terminated names; a null answer is checked.
        let handle = open_first(&library_names(), |name| unsafe { dlopen(name.as_ptr(), RTLD_NOW) })?;
        resolve(|name| unsafe { dlsym(handle, name.as_ptr()) })
    })
    .as_ref()
}

/// Whether Tesseract could be loaded (for the error code when it could not).
pub fn available() -> bool {
    api().is_some()
}

/// One Tesseract instance with the models loaded.
pub struct Engine {
    api: &'static Api,
    handle: *mut TessBaseApi,
}

// SAFETY: a TessBaseAPI may be moved between threads; it is only ever used by one at a time, which
// the Mutex that holds the engine guarantees.
unsafe impl Send for Engine {}

impl Engine {
    /// Load `languages` (e.g. "por+eng") from `tessdata`. `None` when Tesseract cannot, or cannot be loaded.
    pub fn new(tessdata: &Path, languages: &str) -> Option<Engine> {
        let api = api()?;
        let datapath = CString::new(tessdata.to_str()?).ok()?;
        let languages = CString::new(languages).ok()?;
        // SAFETY: plain calls; the handle is checked and deleted on failure.
        unsafe {
            let handle = (api.create)();
            if handle.is_null() {
                return None;
            }
            // Tesseract's own messages ("Estimating resolution", and at exit "WARNING! LEAK!" with the
            // model paths) go to stderr unless told otherwise, and the helper's stderr carries fixed
            // codes and nothing else. `debug_file` is a global setting, so it holds for every
            // message, including the ones printed while the process exits.
            // If Tesseract cannot be silenced, it is not used: its messages would carry model paths.
            if (api.set_variable)(handle, c"debug_file".as_ptr(), c"/dev/null".as_ptr()) == 0 {
                (api.delete)(handle);
                return None;
            }
            // Leptonica, which Tesseract reads images with, prints its own "Error in ..." lines and
            // does not go through `debug_file`.
            (api.set_msg_severity)(LEPTONICA_SILENT);
            if (api.init3)(handle, datapath.as_ptr(), languages.as_ptr()) != 0 {
                (api.delete)(handle);
                return None;
            }
            (api.set_page_seg_mode)(handle, PSM_AUTO);
            Some(Engine { api, handle })
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
            (self.api.set_image)(self.handle, grey.as_ptr(), w, h, 1, w);
            (self.api.set_source_resolution)(self.handle, SOURCE_DPI);
            if (self.api.recognize)(self.handle, std::ptr::null_mut()) != 0 {
                (self.api.clear)(self.handle);
                return Err(());
            }
            let iterator = (self.api.get_iterator)(self.handle);
            if !iterator.is_null() {
                loop {
                    let text = (self.api.iterator_text)(iterator, LEVEL_LINE);
                    let (mut left, mut top, mut right, mut bottom) = (0, 0, 0, 0);
                    let boxed = (self.api.bounding_box)(
                        (self.api.iterator_page)(iterator),
                        LEVEL_LINE,
                        &mut left,
                        &mut top,
                        &mut right,
                        &mut bottom,
                    ) != 0;
                    if !text.is_null() {
                        let line = CStr::from_ptr(text).to_string_lossy().trim().to_owned();
                        (self.api.delete_text)(text);
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
                    if (self.api.iterator_next)(iterator, LEVEL_LINE) == 0 {
                        break;
                    }
                }
                (self.api.iterator_delete)(iterator);
            }
            (self.api.clear)(self.handle);
        }
        Ok(lines)
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: the handle came from TessBaseAPICreate and is deleted once.
        unsafe { (self.api.delete)(self.handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_library_is_looked_for_under_ubuntus_name_then_fedoras() {
        let names: Vec<String> = library_names().iter().map(|n| n.to_str().unwrap().to_owned()).collect();
        assert_eq!(names[0], "libtesseract.so.5", "Debian and Ubuntu first");
        assert!(names.contains(&"libtesseract.so.5.5".to_owned()), "Fedora 44");
        assert_eq!(names.len(), 11);
        assert_eq!(names[1], "libtesseract.so.5.9", "then the newest minor first");
    }

    #[test]
    fn the_first_name_that_opens_is_used() {
        let names = library_names();
        let marker = 0x1000usize as *mut c_void;
        let only_fedora = |name: &CStr| if name == c"libtesseract.so.5.5" { marker } else { std::ptr::null_mut() };
        assert_eq!(open_first(&names, only_fedora), Some(marker));
        assert_eq!(open_first(&names, |_| std::ptr::null_mut()), None);
        let asked = std::cell::RefCell::new(Vec::new());
        let both = |name: &CStr| { asked.borrow_mut().push(name.to_owned()); if name == c"libtesseract.so.5" || name == c"libtesseract.so.5.5" { marker } else { std::ptr::null_mut() } };
        assert_eq!(open_first(&names, both), Some(marker));
        assert_eq!(asked.borrow().len(), 1, "stops at the first that opens");
    }

    #[test]
    fn a_library_missing_any_call_is_not_used() {
        let present = |_: &CStr| 0x1000usize as *mut c_void;
        assert!(resolve(present).is_some());
        for missing in SYMBOLS {
            let lookup = |name: &CStr| if name == missing { std::ptr::null_mut() } else { 0x1000usize as *mut c_void };
            assert!(resolve(lookup).is_none(), "{missing:?}");
        }
        let unique: std::collections::HashSet<&CStr> = SYMBOLS.iter().copied().collect();
        assert_eq!(unique.len(), SYMBOLS.len());
    }

    /// The build machine has Tesseract 5 (Task 0 installs it): the real library loads under one of
    /// the names, with every call the reader makes, Leptonica's included.
    #[test]
    fn the_installed_tesseract_loads_with_every_call() {
        assert!(available());
    }
}
