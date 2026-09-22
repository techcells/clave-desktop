//! The browser toolbar strip: the few lines at the top of a browser window that carry the address
//! and the private-window label.
//!
//! The app needs those separated from the page body so it can tell a public page from a private
//! one without treating page text that happens to contain a host name as an address bar.

use crate::text::Line;

/// Height of the strip, **in points**, per browser.
///
/// Phase 0 (P5) measured the lowest edge of the address row at 74 px in Chrome and 37 px in Safari,
/// both on a 1x display, i.e. 74 and 37 points; the table carries those plus 10%. Points, not a
/// fraction of the window: a toolbar's height is fixed by the browser's chrome and does not grow
/// with the window, so a fraction of a tall window would reach deep into the page. The caller
/// multiplies by the display's pixel scale at capture time.
///
/// Windows keys the table by executable name, which is what the Windows reader reports as the bundle
/// id. Edge 153 on Windows 11 was measured on 2026-09-23 at 150% scaling with a fresh profile: the
/// address row's lowest edge at 68.7 points, the InPrivate badge inside it (55.3 to 64.0), and the
/// page's first line starting at 93.3. The table carries 68.7 plus 10%, as for the other two. Chrome
/// on Windows is NOT measured, so `chrome.exe` has no band and is not read.
const BANDS: &[(&str, f64)] = &[("com.google.Chrome", 82.0), ("com.apple.Safari", 41.0), ("msedge.exe", 76.0)];

/// The band this browser's chrome occupies, in PIXELS of a capture taken at `scale`, or `None` when
/// the bundle id is not a browser whose toolbar has been measured.
///
/// Split out of [`toolbar_text`] so that the evaluation harness can report the band a read was
/// judged against without re-deriving the table. Item 30 of the first-run review is precisely this
/// number being wrong: a bookmarks bar, an extensions row or a tab-group strip pushes the toolbar
/// down until a private-window badge falls BELOW the band, the strip then holds the wrong row, and a
/// private window is kept. Seeing that needs the band and the badge's own box side by side, which is
/// what `read`'s `lines` option exists to provide.
pub fn band_px(bundle_id: Option<&str>, scale: f64) -> Option<f64> {
    BANDS.iter().find(|(id, _)| Some(*id) == bundle_id).map(|(_, points)| *points * scale)
}

/// The toolbar strip of the capture, or `None` when this window is not a browser we know.
///
/// `scale` is the display's pixel-per-point ratio at capture time and `image_height_px` the
/// capture's height in pixels; `lines` are expected in reading order, with `bottom` normalised
/// 0..1 from the top of the capture.
///
/// `Some("")` and `None` mean different things and the app relies on the difference: `None` is
/// "not a browser, do not reason about private windows at all", while `Some("")` is "a browser
/// whose strip came back empty", which is still a browser.
pub fn toolbar_text(lines: &[Line], bundle_id: Option<&str>, scale: f64, image_height_px: f64) -> Option<String> {
    let band_px = band_px(bundle_id, scale)?;
    let inside: Vec<&str> =
        lines.iter().filter(|line| line.bottom * image_height_px <= band_px).map(|line| line.text.as_str()).collect();
    Some(inside.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A line whose bottom edge sits `bottom_px` down a 700 px capture.
    fn at(text: &str, bottom_px: f64) -> Line {
        Line { text: text.to_owned(), x: 0.1, right: 0.3, top: (bottom_px - 16.0) / 700.0, bottom: bottom_px / 700.0 }
    }

    const HEIGHT: f64 = 700.0;

    // -- the band itself -----------------------------------------------------------------------

    #[test]
    fn the_band_is_the_measured_points_times_the_scale() {
        assert_eq!(band_px(Some("com.google.Chrome"), 1.0), Some(82.0));
        assert_eq!(band_px(Some("com.google.Chrome"), 2.0), Some(164.0));
        assert_eq!(band_px(Some("com.apple.Safari"), 1.0), Some(41.0));
        assert_eq!(band_px(Some("com.apple.Safari"), 2.0), Some(82.0));
        assert_eq!(band_px(Some("msedge.exe"), 1.0), Some(76.0));
        assert_eq!(band_px(Some("msedge.exe"), 1.5), Some(114.0));
    }

    #[test]
    fn edge_on_windows_keeps_the_address_row_and_the_inprivate_badge_and_not_the_page() {
        // The measured Edge capture at 150%: 1041 px tall, positions in points times 1.5.
        let height = 1041.0;
        let at_points = |text: &str, top: f64, bottom: f64| Line {
            text: text.to_owned(),
            x: 0.1,
            right: 0.3,
            top: top * 1.5 / height,
            bottom: bottom * 1.5 / height,
        };
        let lines = [
            at_points("CLAVE-BAND probe", 12.0, 28.0),
            at_points("C:/Users/example/page.html", 54.7, 68.7),
            at_points("InPrivate", 55.3, 64.0),
            at_points("FIRST PAGE LINE", 93.3, 115.3),
        ];
        let strip = toolbar_text(&lines, Some("msedge.exe"), 1.5, height).expect("Edge is measured");
        assert!(strip.contains("InPrivate") && strip.contains("page.html"), "{strip}");
        assert!(!strip.contains("FIRST PAGE LINE"), "{strip}");
    }

    #[test]
    fn chrome_on_windows_is_not_measured() {
        assert_eq!(band_px(Some("chrome.exe"), 1.0), None);
    }

    #[test]
    fn a_window_that_is_not_a_measured_browser_has_no_band_at_all() {
        // `None`, not zero: "we have never measured this browser" and "this browser's toolbar is
        // zero tall" are different claims, and only the first one is true.
        assert_eq!(band_px(Some("com.microsoft.VSCode"), 1.0), None);
        assert_eq!(band_px(None, 1.0), None);
    }

    #[test]
    fn an_unknown_bundle_id_has_no_toolbar() {
        assert_eq!(toolbar_text(&[at("anything", 20.0)], Some("com.apple.Terminal"), 1.0, HEIGHT), None);
    }

    #[test]
    fn a_missing_bundle_id_has_no_toolbar() {
        assert_eq!(toolbar_text(&[at("anything", 20.0)], None, 1.0, HEIGHT), None);
    }

    #[test]
    fn chrome_keeps_the_lines_inside_its_band() {
        let lines = [at("example.com/path", 74.0), at("Incognito", 73.0), at("page body", 120.0)];
        let out = toolbar_text(&lines, Some("com.google.Chrome"), 1.0, HEIGHT);
        assert_eq!(out.as_deref(), Some("example.com/path\nIncognito"));
    }

    #[test]
    fn chrome_excludes_a_line_just_below_the_band() {
        // 82 points at 1x; 83 px is out.
        let out = toolbar_text(&[at("tab title", 83.0)], Some("com.google.Chrome"), 1.0, HEIGHT);
        assert_eq!(out.as_deref(), Some(""));
    }

    #[test]
    fn chrome_includes_a_line_exactly_on_the_band_edge() {
        let out = toolbar_text(&[at("edge", 82.0)], Some("com.google.Chrome"), 1.0, HEIGHT);
        assert_eq!(out.as_deref(), Some("edge"));
    }

    #[test]
    fn safaris_band_is_shorter_than_chromes() {
        let lines = [at("127.0.0.1", 37.0), at("STARTMARKER", 60.0)];
        assert_eq!(toolbar_text(&lines, Some("com.apple.Safari"), 1.0, HEIGHT).as_deref(), Some("127.0.0.1"));
        // The same geometry in Chrome reaches further down the page.
        assert_eq!(
            toolbar_text(&lines, Some("com.google.Chrome"), 1.0, HEIGHT).as_deref(),
            Some("127.0.0.1\nSTARTMARKER")
        );
    }

    #[test]
    fn the_band_scales_with_the_display() {
        // The same window on a 2x display: every pixel coordinate doubles, and so must the band.
        let lines = [at("example.com", 148.0), at("body", 170.0)];
        assert_eq!(toolbar_text(&lines, Some("com.google.Chrome"), 2.0, HEIGHT).as_deref(), Some("example.com"));
        assert_eq!(toolbar_text(&lines, Some("com.google.Chrome"), 1.0, HEIGHT).as_deref(), Some(""));
    }

    #[test]
    fn an_empty_band_is_an_empty_string_not_none() {
        // A browser with nothing recognised in its strip is still a browser.
        assert_eq!(toolbar_text(&[at("body", 400.0)], Some("com.google.Chrome"), 1.0, HEIGHT).as_deref(), Some(""));
    }

    #[test]
    fn no_lines_at_all_is_an_empty_string_for_a_browser() {
        assert_eq!(toolbar_text(&[], Some("com.apple.Safari"), 1.0, HEIGHT).as_deref(), Some(""));
        assert_eq!(toolbar_text(&[], Some("com.apple.Finder"), 1.0, HEIGHT), None);
    }

    #[test]
    fn the_band_does_not_depend_on_the_capture_height() {
        // A line 74 px down is inside Chrome's band whether the window is 400 px or 1400 px tall.
        let short =
            Line { text: "example.com".to_owned(), x: 0.1, right: 0.3, top: 58.0 / 400.0, bottom: 74.0 / 400.0 };
        let tall =
            Line { text: "example.com".to_owned(), x: 0.1, right: 0.3, top: 58.0 / 1400.0, bottom: 74.0 / 1400.0 };
        assert_eq!(toolbar_text(&[short], Some("com.google.Chrome"), 1.0, 400.0).as_deref(), Some("example.com"));
        assert_eq!(toolbar_text(&[tall], Some("com.google.Chrome"), 1.0, 1400.0).as_deref(), Some("example.com"));
    }

    #[test]
    fn the_lines_keep_the_order_they_arrive_in() {
        let lines = [at("second", 70.0), at("first", 30.0)];
        // `toolbar_text` does not sort: it trusts the caller's reading order.
        assert_eq!(toolbar_text(&lines, Some("com.google.Chrome"), 1.0, HEIGHT).as_deref(), Some("second\nfirst"));
    }
}
