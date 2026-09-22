//! Greyscale conversion and Apple Vision text recognition.

use objc2::AllocAnyThread;
use objc2::rc::{Retained, autoreleasepool};
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow, CGBitmapContextGetData,
    CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
};
use objc2_foundation::{NSArray, NSDictionary, NSString};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

use crate::text::Line;

/// The languages the recogniser is told to expect, in preference order. English is the working
/// language of the tools this app reads; Brazilian Portuguese is the users'.
const LANGUAGES: [&str; 2] = ["en-US", "pt-BR"];

/// Redraw the capture as an 8-bit greyscale image.
///
/// Text recognition does not use colour, and a single-channel image is a third of the bytes for
/// Vision to walk. It also normalises away whatever pixel format the window server happened to hand
/// us, so recognition sees the same thing for every window.
pub fn to_greyscale(image: &CGImage) -> Option<CFRetained<CGImage>> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    if width == 0 || height == 0 {
        return None;
    }
    let space = CGColorSpace::new_device_gray()?;
    // SAFETY: a null data pointer asks CoreGraphics to allocate and own the bitmap, and a zero
    // bytes-per-row asks it to choose the stride. Eight bits with `AlphaInfo::None` is the one
    // layout DeviceGray accepts.
    let context = unsafe {
        CGBitmapContextCreate(std::ptr::null_mut(), width, height, 8, 0, Some(&space), CGImageAlphaInfo::None.0)
    }?;
    let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width as f64, height as f64));
    CGContext::draw_image(Some(&context), rect, Some(image));
    CGBitmapContextCreateImage(Some(&context))
}

/// A 400 x 120 greyscale image with a few dark bars on a light field, built in memory.
///
/// Used once at start-up so that the first, expensive Vision recognition happens on something we
/// invented rather than on the user's screen. The bars are there so the image is not a flat field;
/// nothing depends on what, if anything, is recognised in it.
pub fn synthetic_grey_image(width: usize, height: usize) -> Option<CFRetained<CGImage>> {
    let space = CGColorSpace::new_device_gray()?;
    // SAFETY: as in `to_greyscale` — CoreGraphics allocates and owns the bitmap.
    let context = unsafe {
        CGBitmapContextCreate(std::ptr::null_mut(), width, height, 8, 0, Some(&space), CGImageAlphaInfo::None.0)
    }?;
    let bytes_per_row = CGBitmapContextGetBytesPerRow(Some(&context));
    let data = CGBitmapContextGetData(Some(&context)).cast::<u8>();
    if data.is_null() {
        return None;
    }
    for y in 0..height {
        for x in 0..width {
            // Six dark bands down the image, each a fifth of a notional line height.
            let ink = (y / 8) % 3 == 0 && (x % 40) < 28;
            // SAFETY: the context owns `bytes_per_row * height` bytes, and `y < height`,
            // `x < width <= bytes_per_row`, so the offset is inside that allocation.
            unsafe { data.add(y * bytes_per_row + x).write(if ink { 0x20 } else { 0xf0 }) };
        }
    }
    CGBitmapContextCreateImage(Some(&context))
}

/// Recognise the text of an image, one [`Line`] per observation.
///
/// Coordinates are converted here, once: Vision's boxes are normalised with the origin at the
/// BOTTOM-left, and every other module in this crate measures from the top.
pub fn recognise_image(image: &CGImage) -> Result<Vec<Line>, ()> {
    autoreleasepool(|_| {
        // objc2 exposes the whole Vision surface as safe functions, unlike ScreenCaptureKit's.
        let request = VNRecognizeTextRequest::new();
        // Accurate, not fast: phase 0 measured 95-100% accuracy this way at about 160 ms.
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        // Language correction "fixes" identifiers, paths and code into words. We want the
        // characters that are on screen, not the sentence the recogniser would prefer.
        request.setUsesLanguageCorrection(false);
        request.setRecognitionLanguages(&NSArray::from_retained_slice(&LANGUAGES.map(NSString::from_str)));

        // SAFETY: `initWithCGImage:options:` takes a live CGImage and an options dictionary.
        let handler = unsafe {
            VNImageRequestHandler::initWithCGImage_options(VNImageRequestHandler::alloc(), image, &NSDictionary::new())
        };
        let requests: Retained<NSArray<VNRequest>> =
            NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(request.clone()))]);
        handler.performRequests_error(&requests).map_err(|_| ())?;

        let mut lines = Vec::new();
        if let Some(results) = request.results() {
            for observation in results.iter() {
                let candidates = observation.topCandidates(1);
                let Some(best) = candidates.iter().next() else { continue };
                // SAFETY: `boundingBox` is a declared property of the observation we were handed;
                // objc2 marks it unsafe only because Vision's observation hierarchy also covers
                // classes for which the box is undefined, which a text observation is not.
                let box_ = unsafe { observation.boundingBox() };
                let text = best.string().to_string();
                lines.push(Line {
                    text,
                    x: box_.origin.x,
                    // The right edge. Vision's box is an origin plus a size, and x grows the same
                    // way on both sides, so this one needs no flip — only the two y values do.
                    right: box_.origin.x + box_.size.width,
                    top: 1.0 - (box_.origin.y + box_.size.height),
                    bottom: 1.0 - box_.origin.y,
                });
            }
        }
        Ok(lines)
    })
}
