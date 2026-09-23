//! Small window handles for Mutter's 64-bit window ids.
//!
//! The rest of the helper names a window by a `u32` (`WindowInfo::window_id`, the read cache, the
//! focus gate), as macOS's window numbers and Windows' HWNDs fit. Mutter's ids are 64-bit and in
//! practice already above 2^31, so rather than widen the type across every platform, this module
//! hands out its own handles, in order, and remembers which Mutter id each one stands for. A capture
//! is given a handle and asks here for the Mutter id to check the focused window against.

use std::collections::HashMap;

/// How many distinct windows are remembered (counted since the helper started, or since the last
/// time the map was full) before it starts again. When it is reached, every old handle becomes
/// unknown: a capture given one cannot find its Mutter id and fails (from Task 3, as a vanished
/// window), and the next front-window question hands out a new handle.
pub const MAX_WINDOWS: usize = 4_096;

#[derive(Debug, Default)]
pub struct IdMap {
    handles: HashMap<u64, u32>,
    mutter_ids: HashMap<u32, u64>,
    last: u32,
}

impl IdMap {
    pub fn new() -> Self {
        Self::default()
    }

    /// The handle for a Mutter id: the same one every time for the same window, a new one for a new
    /// window. Never 0.
    pub fn handle(&mut self, mutter_id: u64) -> u32 {
        if let Some(handle) = self.handles.get(&mutter_id) {
            return *handle;
        }
        if self.handles.len() >= MAX_WINDOWS {
            self.handles.clear();
            self.mutter_ids.clear();
        }
        self.last = match self.last.checked_add(1) {
            Some(next) => next,
            // Four billion windows later: start again, forgetting every handle so none is reused
            // for a different window while it is still remembered.
            None => {
                self.handles.clear();
                self.mutter_ids.clear();
                1
            }
        };
        self.handles.insert(mutter_id, self.last);
        self.mutter_ids.insert(self.last, mutter_id);
        self.last
    }

    /// The Mutter id a handle stands for, if it is still remembered.
    pub fn mutter_id(&self, handle: u32) -> Option<u64> {
        self.mutter_ids.get(&handle).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_window_keeps_its_handle_and_a_new_one_gets_the_next() {
        let mut ids = IdMap::new();
        let a = ids.handle(3_566_480_908);
        let b = ids.handle(3_566_480_909);
        assert_eq!(a, 1);
        assert_eq!(b, 2);
        assert_eq!(ids.handle(3_566_480_908), a);
        assert_eq!(ids.mutter_id(a), Some(3_566_480_908));
        assert_eq!(ids.mutter_id(b), Some(3_566_480_909));
    }

    #[test]
    fn an_unknown_handle_has_no_mutter_id() {
        let mut ids = IdMap::new();
        ids.handle(7);
        assert_eq!(ids.mutter_id(0), None);
        assert_eq!(ids.mutter_id(2), None);
    }

    #[test]
    fn a_full_map_forgets_every_old_handle_and_never_reuses_one() {
        let mut ids = IdMap::new();
        for mutter_id in 0..MAX_WINDOWS as u64 {
            ids.handle(10_000 + mutter_id);
        }
        let first = 1;
        assert_eq!(ids.mutter_id(first), Some(10_000));
        let next = ids.handle(99);
        assert_eq!(next, MAX_WINDOWS as u32 + 1);
        assert_eq!(ids.mutter_id(first), None, "old handles are forgotten");
        assert_eq!(ids.handle(10_000), MAX_WINDOWS as u32 + 2, "a forgotten window gets a fresh handle");
    }

    #[test]
    fn running_out_of_handles_starts_again_at_one_with_nothing_remembered() {
        let mut ids = IdMap::new();
        ids.handle(5);
        ids.last = u32::MAX;
        assert_eq!(ids.handle(6), 1);
        assert_eq!(ids.mutter_id(1), Some(6));
        assert_eq!(ids.handles.get(&5), None);
    }
}
