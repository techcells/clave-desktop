//! The captured pixels, and the two cheap questions we ask of them before Vision is allowed to run.
//!
//! Nothing here touches an Apple API: a `Frame` is a plain byte buffer plus its geometry, so the
//! black check and the same-pixels hash are unit-testable on any machine.

/// One captured image, in whatever pixel layout the window server handed us.
///
/// `bytes_per_row` is usually larger than `width * bytes_per_pixel` (CoreGraphics pads rows to a
/// convenient alignment), which is why every reader below walks rows rather than the flat buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub bytes_per_row: usize,
    pub bytes_per_pixel: usize,
    pub data: Vec<u8>,
}

/// How many channels of a pixel carry colour. Alpha is deliberately excluded from the black check:
/// a fully transparent-but-opaque-alpha BGRA capture has `a == 255` in every pixel, so "all channels
/// <= 8" would never be true for any window. The Swift probe samples exactly three channels; we do
/// the same, and fall back to whatever the pixel has when it has fewer (an 8-bit grey image).
const COLOUR_CHANNELS: usize = 3;

/// Number of sample points per axis in the black check. 16 x 16 = 256 samples, the same grid the
/// phase-0 probes used.
const BLACK_GRID: usize = 16;

/// A pixel channel at or below this value counts as black. Not zero: a captured window that is
/// "black" in practice (a screen-shared surface the system blanked, a sleeping display) comes back
/// with a little dither rather than exact zeros.
const BLACK_LEVEL: u8 = 8;

impl Frame {
    /// Offset of the first byte of pixel (`x`, `y`), or `None` when the buffer is too short for it.
    fn pixel_offset(&self, x: usize, y: usize) -> Option<usize> {
        let start = y.checked_mul(self.bytes_per_row)?.checked_add(x.checked_mul(self.bytes_per_pixel)?)?;
        let end = start.checked_add(self.bytes_per_pixel)?;
        (end <= self.data.len()).then_some(start)
    }

    /// True when a 16 x 16 grid of samples is black in every colour channel.
    ///
    /// A degenerate frame (no pixels, or a buffer shorter than its own geometry claims) is reported
    /// as black: there is nothing to recognise, and `black` is the answer that tells the app to try
    /// again later rather than to treat the window as broken.
    pub fn is_black(&self) -> bool {
        if self.width == 0 || self.height == 0 || self.bytes_per_pixel == 0 {
            return true;
        }
        let channels = self.bytes_per_pixel.min(COLOUR_CHANNELS);
        let last = BLACK_GRID - 1;
        for gy in 0..BLACK_GRID {
            for gx in 0..BLACK_GRID {
                // Spread the samples over the whole frame, corners included.
                let x = (self.width - 1) * gx / last;
                let y = (self.height - 1) * gy / last;
                let Some(offset) = self.pixel_offset(x, y) else {
                    return true;
                };
                if self.data[offset..offset + channels].iter().any(|&c| c > BLACK_LEVEL) {
                    return false;
                }
            }
        }
        true
    }

    /// Two independent 64-bit hashes of every pixel byte, plus the frame's width and height.
    ///
    /// Why two and not one: the pair is the whole evidence that the window has not changed since the
    /// last read, and a collision does not produce a wrong pixel — it produces *stale text* handed to
    /// the app as if it had just been read. A single 64-bit hash is plenty for a lookup table but we
    /// would rather not reason about birthday bounds at all; two hashes built from different mixing
    /// constants behave like one 128-bit hash, which puts an accidental collision far below any rate
    /// worth worrying about. Both are plain multiply-xor folds over 8-byte words (std only, no
    /// dependency), which costs about a millisecond on a 1268 x 708 BGRA frame.
    ///
    /// Row padding is skipped: only `width * bytes_per_pixel` bytes of each row are fed in, so the
    /// hash does not depend on undefined padding bytes that CoreGraphics never promised to zero.
    pub fn pixel_hash(&self) -> (u64, u64) {
        // FNV-1a's offset basis / prime, and the SplitMix64 / golden-ratio constants: two unrelated
        // families, so a word that cancels out in one fold does not cancel out in the other.
        let mut h1: u64 = 0xcbf2_9ce4_8422_2325;
        let mut h2: u64 = 0x9e37_79b9_7f4a_7c15;
        let row_bytes = self.width.saturating_mul(self.bytes_per_pixel);
        for y in 0..self.height {
            let start = y.saturating_mul(self.bytes_per_row);
            let end = start.saturating_add(row_bytes).min(self.data.len());
            if start >= end {
                continue;
            }
            let row = &self.data[start..end];
            let mut chunks = row.chunks_exact(8);
            for chunk in &mut chunks {
                let word = u64::from_le_bytes(chunk.try_into().expect("chunks_exact(8) yields 8 bytes"));
                h1 = mix1(h1, word);
                h2 = mix2(h2, word);
            }
            let tail = chunks.remainder();
            if !tail.is_empty() {
                let mut padded = [0u8; 8];
                padded[..tail.len()].copy_from_slice(tail);
                // The length goes in too, so a short row cannot collide with a zero-padded longer one.
                let word = u64::from_le_bytes(padded) ^ (tail.len() as u64) << 56;
                h1 = mix1(h1, word);
                h2 = mix2(h2, word);
            }
        }
        // Geometry last: two frames whose bytes happen to agree but whose shape differs must not match.
        let geometry = (self.width as u64) << 32 | (self.height as u64 & 0xffff_ffff);
        (mix1(h1, geometry), mix2(h2, geometry))
    }
}

#[inline]
fn mix1(state: u64, word: u64) -> u64 {
    let h = (state ^ word).wrapping_mul(0x0000_0100_0000_01b3);
    h ^ (h >> 29)
}

#[inline]
fn mix2(state: u64, word: u64) -> u64 {
    let h = (state ^ word).wrapping_mul(0x8803_55f2_1e6d_1965);
    h ^ (h >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: usize, height: usize, bpp: usize, fill: u8) -> Frame {
        // A deliberately padded row, so the tests exercise the padding-skipping paths.
        let bytes_per_row = width * bpp + 7;
        Frame { width, height, bytes_per_row, bytes_per_pixel: bpp, data: vec![fill; bytes_per_row * height] }
    }

    #[test]
    fn an_all_zero_frame_is_black() {
        assert!(frame(64, 64, 4, 0).is_black());
    }

    #[test]
    fn dark_but_not_quite_zero_is_still_black() {
        assert!(frame(64, 64, 4, 8).is_black());
    }

    #[test]
    fn one_step_above_the_black_level_is_not_black() {
        assert!(!frame(64, 64, 4, 9).is_black());
    }

    #[test]
    fn opaque_alpha_over_black_colour_is_still_black() {
        // BGRA: colour channels zero, alpha 255. Counting alpha would make every window non-black.
        let mut f = frame(64, 64, 4, 0);
        for y in 0..f.height {
            for x in 0..f.width {
                f.data[y * f.bytes_per_row + x * 4 + 3] = 255;
            }
        }
        assert!(f.is_black());
    }

    #[test]
    fn a_single_bright_sample_point_makes_it_not_black() {
        let mut f = frame(64, 64, 4, 0);
        // (0, 0) is always one of the 256 grid points.
        f.data[0] = 200;
        assert!(!f.is_black());
    }

    #[test]
    fn a_bright_pixel_that_no_sample_point_touches_is_missed() {
        // Documents the sampling, rather than pretending the check is exhaustive.
        let mut f = frame(64, 64, 4, 0);
        let offset = 1 * f.bytes_per_row + 1 * 4;
        f.data[offset] = 255;
        assert!(f.is_black());
    }

    #[test]
    fn an_empty_frame_is_black() {
        assert!(frame(0, 0, 4, 255).is_black());
        assert!(Frame { width: 4, height: 4, bytes_per_row: 16, bytes_per_pixel: 4, data: Vec::new() }.is_black());
    }

    #[test]
    fn a_grey_frame_uses_its_single_channel() {
        assert!(frame(32, 32, 1, 0).is_black());
        assert!(!frame(32, 32, 1, 40).is_black());
    }

    #[test]
    fn the_same_pixels_hash_the_same() {
        assert_eq!(frame(40, 20, 4, 77).pixel_hash(), frame(40, 20, 4, 77).pixel_hash());
    }

    #[test]
    fn one_changed_pixel_changes_both_hashes() {
        let a = frame(40, 20, 4, 77);
        let mut b = a.clone();
        b.data[5 * b.bytes_per_row + 9 * 4 + 2] ^= 0x01;
        let (a1, a2) = a.pixel_hash();
        let (b1, b2) = b.pixel_hash();
        assert_ne!(a1, b1);
        assert_ne!(a2, b2);
    }

    #[test]
    fn padding_bytes_do_not_take_part() {
        let a = frame(40, 20, 4, 77);
        let mut b = a.clone();
        // The last 7 bytes of row 3 are padding beyond width * bytes_per_pixel.
        let padding = 3 * b.bytes_per_row + 40 * 4 + 2;
        b.data[padding] ^= 0xff;
        assert_eq!(a.pixel_hash(), b.pixel_hash());
    }

    #[test]
    fn geometry_takes_part() {
        let a = Frame { width: 8, height: 4, bytes_per_row: 32, bytes_per_pixel: 4, data: vec![1; 128] };
        let b = Frame { width: 4, height: 8, bytes_per_row: 16, bytes_per_pixel: 4, data: vec![1; 128] };
        assert_ne!(a.pixel_hash(), b.pixel_hash());
    }

    #[test]
    fn the_two_hashes_are_not_the_same_function() {
        let (h1, h2) = frame(16, 16, 4, 3).pixel_hash();
        assert_ne!(h1, h2);
    }
}
