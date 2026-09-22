//! The one-entry same-pixels cache.
//!
//! A user who stares at an unchanged window costs us one capture and no recognition: the capture is
//! cheap (about 90 ms was measured for capture + recognition together, most of it recognition),
//! and recognising pixels we have already read produces the same string every time. The cache is
//! deliberately one entry deep — its only job is "this is the same window, still showing the same
//! thing" — so it can never grow, never needs eviction, and never holds text for a window the user
//! has left.

/// What a completed read is worth remembering.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    window_id: u32,
    hash: (u64, u64),
    text: String,
    toolbar: Option<String>,
}

#[derive(Debug, Default)]
pub struct ReadCache {
    entry: Option<Entry>,
}

impl ReadCache {
    pub fn new() -> Self {
        Self { entry: None }
    }

    /// Forget the entry unless it belongs to `window_id`.
    ///
    /// Called with the front window's id at the top of every read: the moment the user is looking at
    /// a different window, the remembered text is no longer an answer to any question we might be
    /// asked, and keeping it around is a way to answer with another window's contents by accident.
    pub fn clear_unless(&mut self, window_id: u32) {
        if self.entry.as_ref().is_some_and(|e| e.window_id != window_id) {
            self.entry = None;
        }
    }

    /// Forget everything.
    ///
    /// Called from every place that means "this window is not being read now" — the screen locked,
    /// the grant gone, no window in front, and the worker thread sitting idle — so that recognised
    /// text does not outlive the reading it came from.
    ///
    /// What this does and does not promise: the `String` is dropped, so nothing in the process holds
    /// the text any more and nothing can retrieve it. Rust makes no promise about *zeroing* the
    /// freed bytes, and neither does the allocator, so the page may still contain them until it is
    /// reused. The app's claim is about data the app retains, not about pages the allocator has not
    /// yet overwritten; that distinction is the honest one and it is the one this method keeps.
    pub fn clear(&mut self) {
        self.entry = None;
    }

    /// Whether nothing at all is remembered, for any window.
    ///
    /// Tests only, and it exists because the invariant worth asserting is about the CACHE and not
    /// about one key in it: "a read that ended in a refusal left no text behind" must hold whatever
    /// window id and whatever pixels the text was stored under, and a `lookup` can only ask about a
    /// pair the test happens to know.
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entry.is_none()
    }

    /// The remembered text, if this is the same window showing exactly the same pixels.
    pub fn lookup(&self, window_id: u32, hash: (u64, u64)) -> Option<(String, Option<String>)> {
        let entry = self.entry.as_ref()?;
        (entry.window_id == window_id && entry.hash == hash).then(|| (entry.text.clone(), entry.toolbar.clone()))
    }

    /// Remember this read, replacing whatever was there.
    pub fn store(&mut self, window_id: u32, hash: (u64, u64), text: String, toolbar: Option<String>) {
        self.entry = Some(Entry { window_id, hash, text, toolbar });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: (u64, u64) = (1, 2);

    #[test]
    fn a_fresh_cache_answers_nothing() {
        assert_eq!(ReadCache::new().lookup(7, H), None);
    }

    #[test]
    fn the_same_window_and_the_same_pixels_hit() {
        let mut cache = ReadCache::new();
        cache.store(7, H, "hello".to_owned(), Some("bar".to_owned()));
        assert_eq!(cache.lookup(7, H), Some(("hello".to_owned(), Some("bar".to_owned()))));
    }

    #[test]
    fn different_pixels_miss() {
        let mut cache = ReadCache::new();
        cache.store(7, H, "hello".to_owned(), None);
        assert_eq!(cache.lookup(7, (1, 3)), None);
        assert_eq!(cache.lookup(7, (9, 2)), None);
    }

    #[test]
    fn a_different_window_misses_even_with_the_same_pixels() {
        let mut cache = ReadCache::new();
        cache.store(7, H, "hello".to_owned(), None);
        assert_eq!(cache.lookup(8, H), None);
    }

    #[test]
    fn clearing_keeps_the_entry_for_the_same_window() {
        let mut cache = ReadCache::new();
        cache.store(7, H, "hello".to_owned(), None);
        cache.clear_unless(7);
        assert!(cache.lookup(7, H).is_some());
    }

    #[test]
    fn clearing_drops_the_entry_for_another_window() {
        let mut cache = ReadCache::new();
        cache.store(7, H, "hello".to_owned(), None);
        cache.clear_unless(8);
        assert_eq!(cache.lookup(7, H), None);
    }

    #[test]
    fn clearing_forgets_the_entry_whatever_window_it_belonged_to() {
        let mut cache = ReadCache::new();
        cache.store(7, H, "hello".to_owned(), Some("bar".to_owned()));
        cache.clear();
        assert_eq!(cache.lookup(7, H), None);
        cache.clear(); // twice is fine
        assert_eq!(cache.lookup(7, H), None);
    }

    #[test]
    fn storing_replaces_the_single_entry() {
        let mut cache = ReadCache::new();
        cache.store(7, H, "old".to_owned(), None);
        cache.store(8, (3, 4), "new".to_owned(), Some(String::new()));
        assert_eq!(cache.lookup(7, H), None);
        assert_eq!(cache.lookup(8, (3, 4)), Some(("new".to_owned(), Some(String::new()))));
    }
}
