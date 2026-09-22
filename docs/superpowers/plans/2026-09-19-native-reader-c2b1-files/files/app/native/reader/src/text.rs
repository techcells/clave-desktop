//! Turning a bag of recognised lines into the string the app reads.
//!
//! Two jobs live here and neither needs an Apple API, so both are unit-tested everywhere:
//! [`order`] puts the lines into reading order, and [`assemble`] cleans each line up and joins them.

use std::cmp::Ordering;

/// One recognised line. Coordinates are normalised 0..1 and measured from the TOP-left corner of
/// the capture, which is *not* what Vision hands out (its boxes are bottom-left); the macOS layer
/// flips them once, on the way in, so that everything above this line reads the same way as a human.
///
/// `x` is the box's left edge and `right` its right edge. Nothing in the reading rules looks at
/// `right`: the gutter rules ask only how far left a line starts and the toolbar band only how far
/// down it ends. It is carried because the recogniser already knows it and the staged-window
/// evaluation needs a whole box to say WHERE a browser's private badge sat — see
/// [`crate::scheduler::ReadGeometry`]. Reconstructing it later is impossible.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub text: String,
    pub x: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

/// A line whose left edge is inside this fraction of the capture is a candidate for the
/// editor-gutter rules below. 8% of a window is well to the left of any prose.
const GUTTER_X: f64 = 0.08;

/// How many left-edge numbers must run consecutively — each exactly one more than the last — before
/// we believe they are a line-number column. Two could be a coincidence (a chat timestamp, a date
/// beside a total, a two-item list); three in a row, one apart, is a gutter.
///
/// **What this costs, and it is not hypothetical.** A numbered list hard against the left edge whose
/// items are numbered with a bare digit — `1 Install` / `2 Configure` / `3 Run` — is three left-edge
/// numbers stepping by one, so by this rule it IS a gutter and the numerals are stripped: the text
/// comes back as `Install` / `Configure` / `Run`. Any punctuation after the digit saves the list
/// whole, because [`gutter_prefix_len`] requires whitespace immediately after the digits: `1. Install`
/// and `1) Install` are content and keep every character. All three are pinned by the tests named
/// `a_bare_numbered_list_…`, `a_numbered_list_written_with_a_full_stop_…` and
/// `…_with_a_bracket_…`, so the behaviour cannot drift away from this paragraph unnoticed.
///
/// The trade is accepted deliberately. A stripped list still reads in order and loses only labels a
/// reader can infer; a gutter left in the text is line numbers glued to every line of source the
/// extraction model then reads as if they were part of the code. There is no evidence that separates
/// the two cases: at the left edge of a window, `1 Install` and `1 fn main() {` are the same shape.
const GUTTER_MIN_LINES: usize = 3;

/// Sort the lines into reading order: top to bottom, and left to right inside a row.
///
/// Lines whose tops differ by less than half the height of the row's first line are treated as one
/// row. That tolerance comes from the phase-0 probes: a row of a chat window or a toolbar is
/// recognised as several observations whose boxes are close but not identical in height.
pub fn order(mut lines: Vec<Line>) -> Vec<Line> {
    // Not `total_cmp`, because a NaN coordinate should not reorder the rest; treat it as equal and
    // let the stable sort keep the input order for it.
    lines.sort_by(|a, b| a.top.partial_cmp(&b.top).unwrap_or(Ordering::Equal));
    let mut rows: Vec<Vec<Line>> = Vec::new();
    for line in lines {
        match rows.last_mut() {
            Some(row) if same_row(&row[0], &line) => row.push(line),
            _ => rows.push(vec![line]),
        }
    }
    rows.into_iter()
        .flat_map(|mut row| {
            row.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(Ordering::Equal));
            row
        })
        .collect()
}

fn same_row(first: &Line, candidate: &Line) -> bool {
    let height = first.bottom - first.top;
    (candidate.top - first.top).abs() < height * 0.5
}

/// Clean each line up and join the lines with `"\n"`.
///
/// The clean-up is, in order: homoglyph normalisation (see [`normalise_homoglyphs`]) and then the
/// editor-gutter rules (see the module tests). Nothing is ever invented or padded: a line the
/// recogniser did not produce is simply absent from the result.
///
/// **The homoglyph pass runs here even though `scheduler::handle_read` has already run it over every
/// line, and the second call is deliberate, not an oversight.** The scheduler normalises first
/// because the browser toolbar strip is cut from those same lines *before* this function ever sees
/// them: a Cyrillic `o` inside an `Incognito` badge has to be repaired before the strip is taken, or
/// the app's search for the badge misses and a private window is kept. This call is what makes
/// `assemble` correct on its own — for its own tests, and for any future caller that has not
/// normalised — so neither call can be removed by looking only at the other. `normalise_homoglyphs`
/// is idempotent (`normalisation_is_idempotent`), so the cost of running it twice is one more scan
/// of a line that by then contains no twins at all, and the result is identical either way.
pub fn assemble(lines: &[Line]) -> String {
    join(&cleaned(lines))
}

/// The lines the assembled text is made of — cleaned by the rules above, each still carrying the
/// box it was recognised in.
///
/// [`assemble`] is this function followed by [`join`], and that composition is the whole point of
/// splitting them: a caller that wants to say WHERE a line of the answer's text sat gets the boxes
/// of exactly the lines the text is made of. A line the gutter rules drop has no box, and a line
/// whose number was stripped carries the stripped text. Measuring the raw recogniser lines instead
/// would put strings in front of the evaluation that the answer's `text` does not contain, and an
/// index into the boxes would not be an index into the text — the two lists can differ in length,
/// not only in content. See [`crate::scheduler::ReadGeometry`], which is the only caller that needs
/// the boxes.
pub fn cleaned(lines: &[Line]) -> Vec<Line> {
    let texts: Vec<String> = lines.iter().map(|line| normalise_homoglyphs(&line.text)).collect();
    let marks = gutter_marks(lines, &texts);
    let mut out: Vec<Line> = Vec::with_capacity(texts.len());
    for ((line, text), mark) in lines.iter().zip(texts).zip(marks) {
        let kept = match mark {
            // The whole line was a line number; there is no content under it to keep.
            Some(Gutter::Whole) => continue,
            Some(Gutter::Prefix(prefix)) => text[prefix..].to_owned(),
            None => text,
        };
        out.push(Line { text: kept, x: line.x, right: line.right, top: line.top, bottom: line.bottom });
    }
    out
}

/// The one place the answer's `text` is made: the lines' text, joined with `"\n"`.
///
/// Nothing is ever invented or padded — a line the recogniser did not produce is simply absent —
/// so a caller holding the lines from [`cleaned`] can produce the identical string, and that is
/// what makes "every box carries a line of the text" a fact rather than a hope.
pub fn join(lines: &[Line]) -> String {
    lines.iter().map(|line| line.text.as_str()).collect::<Vec<_>>().join("\n")
}

// ---------------------------------------------------------------------------------------------
// Homoglyphs
// ---------------------------------------------------------------------------------------------

/// Cyrillic and Greek characters that are visually identical to a Latin letter, and that letter.
///
/// Kept as escapes on purpose: a reviewer can check a code point against the Unicode charts, and no
/// editor, terminal or copy-paste step can silently swap one of these for its Latin twin — which is
/// exactly the bug this table exists to undo.
const TWINS: &[(char, char)] = &[
    // Cyrillic capitals
    ('\u{0410}', 'A'), // CYRILLIC CAPITAL LETTER A
    ('\u{0412}', 'B'), // CYRILLIC CAPITAL LETTER VE
    ('\u{0415}', 'E'), // CYRILLIC CAPITAL LETTER IE
    ('\u{041A}', 'K'), // CYRILLIC CAPITAL LETTER KA
    ('\u{041C}', 'M'), // CYRILLIC CAPITAL LETTER EM
    ('\u{041D}', 'H'), // CYRILLIC CAPITAL LETTER EN
    ('\u{041E}', 'O'), // CYRILLIC CAPITAL LETTER O
    ('\u{0420}', 'P'), // CYRILLIC CAPITAL LETTER ER
    ('\u{0421}', 'C'), // CYRILLIC CAPITAL LETTER ES
    ('\u{0422}', 'T'), // CYRILLIC CAPITAL LETTER TE
    ('\u{0425}', 'X'), // CYRILLIC CAPITAL LETTER HA
    // Cyrillic small letters
    ('\u{0430}', 'a'), // CYRILLIC SMALL LETTER A
    ('\u{0435}', 'e'), // CYRILLIC SMALL LETTER IE
    ('\u{043E}', 'o'), // CYRILLIC SMALL LETTER O
    ('\u{0440}', 'p'), // CYRILLIC SMALL LETTER ER
    ('\u{0441}', 'c'), // CYRILLIC SMALL LETTER ES
    ('\u{0443}', 'y'), // CYRILLIC SMALL LETTER U
    ('\u{0445}', 'x'), // CYRILLIC SMALL LETTER HA
    ('\u{0456}', 'i'), // CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
    ('\u{0458}', 'j'), // CYRILLIC SMALL LETTER JE
    ('\u{0455}', 's'), // CYRILLIC SMALL LETTER DZE
    // Greek capitals
    ('\u{0391}', 'A'), // GREEK CAPITAL LETTER ALPHA
    ('\u{0392}', 'B'), // GREEK CAPITAL LETTER BETA
    ('\u{0395}', 'E'), // GREEK CAPITAL LETTER EPSILON
    ('\u{0396}', 'Z'), // GREEK CAPITAL LETTER ZETA
    ('\u{0397}', 'H'), // GREEK CAPITAL LETTER ETA
    ('\u{0399}', 'I'), // GREEK CAPITAL LETTER IOTA
    ('\u{039A}', 'K'), // GREEK CAPITAL LETTER KAPPA
    ('\u{039C}', 'M'), // GREEK CAPITAL LETTER MU
    ('\u{039D}', 'N'), // GREEK CAPITAL LETTER NU
    ('\u{039F}', 'O'), // GREEK CAPITAL LETTER OMICRON
    ('\u{03A1}', 'P'), // GREEK CAPITAL LETTER RHO
    ('\u{03A4}', 'T'), // GREEK CAPITAL LETTER TAU
    ('\u{03A5}', 'Y'), // GREEK CAPITAL LETTER UPSILON
    ('\u{03A7}', 'X'), // GREEK CAPITAL LETTER CHI
    // Greek small letters
    ('\u{03BF}', 'o'), // GREEK SMALL LETTER OMICRON
    ('\u{03BD}', 'v'), // GREEK SMALL LETTER NU
];

/// Replace Cyrillic/Greek look-alikes with their Latin twins, where doing so cannot corrupt real
/// Cyrillic or Greek text.
///
/// Phase 0 measured Vision returning `U+0410 CYRILLIC CAPITAL LETTER A` in place of a Latin `A`,
/// in the same English words, on some reads and not others. Downstream everything — secret
/// patterns, name and phone rules, skill matching, the English check — is plain substring and
/// pattern matching, which a homoglyph defeats silently. So the text is normalised once, here,
/// before anybody matches on it.
///
/// The rule is one sentence, applied to each whitespace-delimited word of the line on its own:
/// **a word that itself contains at least one Latin letter** (ASCII, Latin-1 Supplement or Latin
/// Extended-A/B) **has every twin in it replaced**; any other word is returned exactly as it came.
/// The evidence and the repair are therefore always inside the same word — nothing about the rest
/// of the line can make a word be rewritten. Both measured phase-0 cases are of this shape:
/// `Аcceptance` and `MAX_АTTEMPTS` are Latin words with one Cyrillic character in them.
///
/// **What is deliberately NOT repaired, and why.** A word the recogniser rendered *entirely* in
/// twin letters is left alone, even when the rest of the line is plainly English. There is no way
/// to tell such a word from real Cyrillic or Greek, because in those scripts whole words are made
/// of twins: every capital of `МОСКВА`, `ОХРАНА` and `СОН` is a twin, so is every letter of `Рус`
/// and of Greek `ΟΧΙ`. An earlier version of this function used "some other word on the line has an
/// ASCII letter" as the licence to repair, and it turned `МОСКВА team standup` into
/// `MOCKBA team standup` — silent, undetectable corruption of a bilingual user's own words on the
/// way into the extraction model. Reading someone's screen wrongly is worse than reading it
/// incompletely: a homoglyph that survives costs one missed match, a rewritten word costs the user
/// their language. So the trade is made in favour of never rewriting, and the residual case — an
/// English word misread wholly in Cyrillic capitals — stays as it is.
///
/// Accented Latin text (`São João às 14h30`) contains no twins at all and is returned untouched;
/// so are `Привет мир` and `Ελληνικά`, which contain no Latin letter.
pub fn normalise_homoglyphs(line: &str) -> String {
    if !line.chars().any(is_twin) {
        return line.to_owned(); // The overwhelmingly common case: nothing to do, no allocation churn.
    }
    let mut out = String::with_capacity(line.len());
    // Rebuild the line word by word while copying the original whitespace back verbatim, so
    // indentation and column alignment survive.
    for piece in split_keeping_whitespace(line) {
        match piece {
            Piece::Space(s) => out.push_str(s),
            Piece::Word(w) if should_normalise_word(w) => {
                out.extend(w.chars().map(|c| twin_of(c).unwrap_or(c)));
            }
            Piece::Word(w) => out.push_str(w),
        }
    }
    out
}

/// A word is repaired only on evidence it carries itself: at least one twin to repair, and at least
/// one Latin letter proving the word is being written in the Latin script.
fn should_normalise_word(word: &str) -> bool {
    word.chars().any(is_twin) && word.chars().any(is_latin_letter)
}

fn twin_of(c: char) -> Option<char> {
    TWINS.iter().find(|(from, _)| *from == c).map(|(_, to)| *to)
}

fn is_twin(c: char) -> bool {
    // Cheap reject first: every entry in TWINS is Greek (U+0370..) or Cyrillic (..U+045F).
    ('\u{0370}'..='\u{045F}').contains(&c) && twin_of(c).is_some()
}

/// ASCII letters plus the Latin-1 Supplement and Latin Extended-A/B letter blocks, i.e. what
/// `São`, `João` and `às` are written in. `U+00D7 MULTIPLICATION SIGN` and `U+00F7 DIVISION SIGN`
/// sit inside the Latin-1 range but are symbols, not letters.
fn is_latin_letter(c: char) -> bool {
    match c {
        'A'..='Z' | 'a'..='z' => true,
        '\u{00D7}' | '\u{00F7}' => false,
        '\u{00C0}'..='\u{00FF}' | '\u{0100}'..='\u{024F}' => true,
        _ => false,
    }
}

enum Piece<'a> {
    Word(&'a str),
    Space(&'a str),
}

/// Split into alternating runs of whitespace and non-whitespace, keeping both.
fn split_keeping_whitespace(line: &str) -> Vec<Piece<'_>> {
    let mut pieces = Vec::new();
    let mut start = 0usize;
    let mut in_space: Option<bool> = None;
    for (index, c) in line.char_indices() {
        let space = c.is_whitespace();
        match in_space {
            Some(previous) if previous == space => {}
            Some(previous) => {
                pieces.push(if previous {
                    Piece::Space(&line[start..index])
                } else {
                    Piece::Word(&line[start..index])
                });
                start = index;
            }
            None => start = index,
        }
        in_space = Some(space);
    }
    if let Some(previous) = in_space {
        pieces.push(if previous { Piece::Space(&line[start..]) } else { Piece::Word(&line[start..]) });
    }
    pieces
}

// ---------------------------------------------------------------------------------------------
// Editor gutters
// ---------------------------------------------------------------------------------------------

/// What a line is, as far as the gutter rules are concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gutter {
    /// The whole line is the number: an editor's line number recognised as its own observation.
    Whole,
    /// The number is glued to the start of the content; this many bytes are the number and the
    /// whitespace after it.
    Prefix(usize),
}

/// Length in bytes of a leading `\d{1,5}\s{1,3}` run, if the line starts with one.
fn gutter_prefix_len(text: &str) -> Option<usize> {
    let digits: usize = text.chars().take_while(|c| c.is_ascii_digit()).count();
    if !(1..=5).contains(&digits) {
        return None;
    }
    let rest: &str = &text[digits..]; // ASCII digits are one byte each.
    let spaces = rest.chars().take_while(|c| c.is_whitespace()).take(3).collect::<Vec<_>>();
    if spaces.is_empty() {
        return None;
    }
    Some(digits + spaces.iter().map(|c| c.len_utf8()).sum::<usize>())
}

/// The number a left-edge line carries, and in what shape — or `None` if it carries none.
fn gutter_candidate(text: &str, x: f64) -> Option<(u32, Gutter)> {
    if !(x < GUTTER_X) {
        return None; // Written this way so a NaN x is never treated as a gutter.
    }
    let trimmed = text.trim();
    if (1..=6).contains(&trimmed.chars().count()) && trimmed.chars().all(|c| c.is_ascii_digit()) {
        return trimmed.parse().ok().map(|number| (number, Gutter::Whole));
    }
    let prefix = gutter_prefix_len(text)?;
    text[..prefix].trim().parse().ok().map(|number| (number, Gutter::Prefix(prefix)))
}

/// Decide, for each line, whether it is part of an editor's line-number column.
///
/// A number at the left edge is only a line number when it is one of a **run of at least
/// [`GUTTER_MIN_LINES`] left-edge numbers that step by exactly one**. Nothing weaker will do, and
/// the reason is that the rules below *delete text*: a lone `404 Not Found`, `3 files changed`,
/// `1 + 2 = 3` or a bare `42` at the left margin is content, and an earlier version of this code —
/// which asked only whether the frame contained some increasing run *somewhere* — turned
/// `404 Not Found` into `Not Found` and dropped `42` entirely. Requiring the line itself to sit
/// inside the run means a false positive needs three numbers in a row, one apart, hard against the
/// left edge: that is a gutter, not prose.
///
/// Lines that carry no number do not break a run (an editor's own output can be recognised as one
/// observation in the middle of the column), but a number that does not continue the sequence does.
/// The cost is only ever under-stripping, which leaves a line number in the text; the benefit is
/// that content is never eaten.
fn gutter_marks(lines: &[Line], texts: &[String]) -> Vec<Option<Gutter>> {
    let candidates: Vec<(usize, u32, Gutter)> = texts
        .iter()
        .enumerate()
        .filter_map(|(index, text)| {
            gutter_candidate(text, lines[index].x).map(|(number, shape)| (index, number, shape))
        })
        .collect();

    let mut marks = vec![None; lines.len()];
    let mut start = 0usize;
    while start < candidates.len() {
        let mut end = start + 1;
        while end < candidates.len() && candidates[end].1 == candidates[end - 1].1 + 1 {
            end += 1;
        }
        if end - start >= GUTTER_MIN_LINES {
            for &(index, _, shape) in &candidates[start..end] {
                marks[index] = Some(shape);
            }
        }
        start = end;
    }
    marks
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `right` is a fifth of the capture to the right of `x`: no rule in this module reads it, and
    /// giving it a plausible value keeps the fixtures honest about what a real box looks like.
    fn line(text: &str, x: f64, top: f64, bottom: f64) -> Line {
        Line { text: text.to_owned(), x, right: x + 0.2, top, bottom }
    }

    fn texts(lines: &[Line]) -> Vec<&str> {
        lines.iter().map(|l| l.text.as_str()).collect()
    }

    // -- order ---------------------------------------------------------------------------------

    #[test]
    fn lines_come_back_top_to_bottom() {
        let ordered = order(vec![line("c", 0.1, 0.60, 0.64), line("a", 0.1, 0.10, 0.14), line("b", 0.1, 0.30, 0.34)]);
        assert_eq!(texts(&ordered), ["a", "b", "c"]);
    }

    #[test]
    fn lines_on_the_same_row_come_back_left_to_right() {
        // Tops differ by 0.01, less than half of the first line's 0.04 height.
        let ordered = order(vec![line("right", 0.8, 0.105, 0.145), line("left", 0.2, 0.100, 0.140)]);
        assert_eq!(texts(&ordered), ["left", "right"]);
    }

    #[test]
    fn a_line_more_than_half_a_height_below_starts_a_new_row() {
        let ordered = order(vec![line("below", 0.8, 0.125, 0.165), line("above", 0.2, 0.100, 0.140)]);
        assert_eq!(texts(&ordered), ["above", "below"]);
    }

    #[test]
    fn a_row_is_measured_against_its_first_line_not_the_previous_one() {
        // Each step down is 0.015, under half of the 0.04 line height, so a rule that compared each
        // line with the *previous* one would chain all three into one row and return them by x, as
        // "c", "a", "b". Measured against the row's first line, only "a" and "b" share a row.
        let ordered =
            order(vec![line("a", 0.5, 0.100, 0.140), line("b", 0.6, 0.115, 0.155), line("c", 0.3, 0.130, 0.170)]);
        assert_eq!(texts(&ordered), ["a", "b", "c"]);
    }

    #[test]
    fn ordering_an_empty_frame_is_empty() {
        assert!(order(Vec::new()).is_empty());
    }

    // -- homoglyphs ----------------------------------------------------------------------------

    #[test]
    fn a_latin_word_with_one_cyrillic_capital_is_repaired() {
        // "Аcceptance criteria" with U+0410 for the leading A — measured in phase 0.
        assert_eq!(normalise_homoglyphs("\u{0410}cceptance criteria"), "Acceptance criteria");
    }

    #[test]
    fn a_latin_identifier_with_one_cyrillic_capital_is_repaired() {
        // "MAX_АTTEMPTS" with U+0410 after the underscore — measured in phase 0.
        assert_eq!(normalise_homoglyphs("MAX_\u{0410}TTEMPTS"), "MAX_ATTEMPTS");
    }

    #[test]
    fn real_cyrillic_text_is_left_alone() {
        // "Привет мир". Both words contain Cyrillic letters with no Latin twin.
        let russian = "\u{041F}\u{0440}\u{0438}\u{0432}\u{0435}\u{0442} \u{043C}\u{0438}\u{0440}";
        assert_eq!(normalise_homoglyphs(russian), russian);
    }

    #[test]
    fn real_greek_text_is_left_alone() {
        // "Ελληνικά".
        let greek = "\u{0395}\u{03BB}\u{03BB}\u{03B7}\u{03BD}\u{03B9}\u{03BA}\u{03AC}";
        assert_eq!(normalise_homoglyphs(greek), greek);
    }

    #[test]
    fn accented_latin_text_is_left_alone() {
        assert_eq!(normalise_homoglyphs("São João às 14h30"), "São João às 14h30");
    }

    #[test]
    fn symbols_are_left_alone() {
        assert_eq!(normalise_homoglyphs("✓ ❯ ×"), "✓ ❯ ×");
    }

    #[test]
    fn an_all_twin_word_beside_latin_text_is_left_alone() {
        // "СОМ port", where the first word is entirely Cyrillic twins (ES, O, EM). Latin text next
        // to it is not evidence about it: the word is indistinguishable from real Cyrillic, and the
        // tests below are the words this costs us if we guess.
        let word = "\u{0421}\u{041E}\u{041C}";
        assert_eq!(normalise_homoglyphs(&format!("{word} port")), format!("{word} port"));
    }

    #[test]
    fn all_caps_cyrillic_beside_english_survives() {
        // "МОСКВА today" — every capital of "Moscow" is a twin, so a line-level rule rewrites the
        // whole word. Measured against the previous implementation: it produced "MOCKBA today".
        let moscow = "\u{041C}\u{041E}\u{0421}\u{041A}\u{0412}\u{0410}";
        assert_eq!(normalise_homoglyphs(&format!("{moscow} today")), format!("{moscow} today"));
    }

    #[test]
    fn a_short_all_caps_cyrillic_word_beside_english_survives() {
        // "СОН mode" — Russian for "sleep"; ES, O, EN are all twins.
        let sleep = "\u{0421}\u{041E}\u{041D}";
        assert_eq!(normalise_homoglyphs(&format!("{sleep} mode")), format!("{sleep} mode"));
    }

    #[test]
    fn all_caps_greek_beside_english_survives() {
        // "ΟΧΙ now" — Greek for "no"; OMICRON, CHI, IOTA are all twins.
        let no = "\u{039F}\u{03A7}\u{0399}";
        assert_eq!(normalise_homoglyphs(&format!("{no} now")), format!("{no} now"));
    }

    #[test]
    fn a_lower_case_all_twin_cyrillic_word_beside_english_survives() {
        // "Рус and Eng" — ER, U, ES are all twins, and two English words sit beside it.
        let rus = "\u{0420}\u{0443}\u{0441}";
        assert_eq!(normalise_homoglyphs(&format!("{rus} and Eng")), format!("{rus} and Eng"));
    }

    #[test]
    fn an_all_twin_word_on_its_own_is_left_alone() {
        // The same word with no Latin anywhere on the line stays as it is: it could be real Cyrillic.
        let word = "\u{0421}\u{041E}\u{041C}";
        assert_eq!(normalise_homoglyphs(word), word);
    }

    #[test]
    fn a_cyrillic_word_with_a_non_twin_letter_survives_latin_neighbours() {
        // "Сом" (ES, O, EM-lowercase) — the lowercase м has no twin, so the word is real Cyrillic.
        let fish = "\u{0421}\u{043E}\u{043C}";
        assert_eq!(normalise_homoglyphs(&format!("{fish} fish")), format!("{fish} fish"));
    }

    #[test]
    fn whitespace_and_indentation_survive_normalisation() {
        assert_eq!(normalise_homoglyphs("  \u{0410}bc\tdef  "), "  Abc\tdef  ");
    }

    #[test]
    fn a_greek_capital_inside_a_latin_word_is_repaired() {
        // "ΑPI" with U+0391 GREEK CAPITAL LETTER ALPHA.
        assert_eq!(normalise_homoglyphs("\u{0391}PI key"), "API key");
    }

    #[test]
    fn normalisation_is_idempotent() {
        let once = normalise_homoglyphs("\u{0410}cceptance criteria");
        assert_eq!(normalise_homoglyphs(&once), once);
    }

    /// The fixture `../fixtures/homoglyphs.json` is shared with sub-project A's port of this
    /// function (`app/src/core/text/homoglyphs.ts`), which asserts the same two things about the
    /// same cases. Nothing else keeps the two implementations honest: A repairs the text a second
    /// time because it must not assume which reader produced a read (spec 10.1 item 13), and two
    /// rules that disagreed would mean the text a matcher sees depends on the reader after all.
    /// The fixture is pure ASCII, with every look-alike written as a JSON escape, for the same
    /// reason the table above is escaped.
    #[test]
    fn the_shared_fixture_holds_in_this_implementation_too() {
        let raw = include_str!("../fixtures/homoglyphs.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
        let cases = fixture["cases"].as_array().expect("fixture has cases");
        assert!(cases.len() >= 18, "fixture shrank to {} cases", cases.len());
        for case in cases {
            let name = case["name"].as_str().expect("case has a name");
            let input = case["in"].as_str().expect("case has an input");
            let expected = case["out"].as_str().expect("case has an output");
            assert_eq!(normalise_homoglyphs(input), expected, "case {name:?}");
            // Idempotence, which is what makes repairing a second time in sub-project A safe.
            assert_eq!(normalise_homoglyphs(expected), expected, "case {name:?} is not idempotent");
        }
    }

    // -- assembly ------------------------------------------------------------------------------

    #[test]
    fn assembly_puts_each_line_on_its_own_line() {
        let out = assemble(&[line("alpha", 0.2, 0.1, 0.14), line("beta", 0.2, 0.2, 0.24)]);
        assert_eq!(out, "alpha\nbeta");
    }

    #[test]
    fn assembly_normalises_homoglyphs() {
        let out = assemble(&[line("\u{0410}cceptance criteria", 0.2, 0.1, 0.14)]);
        assert_eq!(out, "Acceptance criteria");
    }

    #[test]
    fn bare_line_numbers_in_a_run_are_dropped() {
        // An editor whose gutter was recognised as its own observations, one number per line.
        let out = assemble(&[
            line("10", 0.01, 0.10, 0.14),
            line("fn main() {", 0.09, 0.10, 0.14),
            line("11", 0.01, 0.20, 0.24),
            line("  let x = 1;", 0.09, 0.20, 0.24),
            line("  12  ", 0.01, 0.30, 0.34),
            line("}", 0.09, 0.30, 0.34),
        ]);
        assert_eq!(out, "fn main() {\n  let x = 1;\n}");
    }

    #[test]
    fn a_lone_bare_number_at_the_left_edge_is_content() {
        // Nothing to run with, so "42" is a number somebody wrote, not a line number.
        assert_eq!(assemble(&[line("42", 0.01, 0.1, 0.14)]), "42");
        assert_eq!(assemble(&[line("  7 ", 0.01, 0.1, 0.14), line("body", 0.5, 0.2, 0.24)]), "  7 \nbody");
    }

    #[test]
    fn a_bare_number_away_from_the_left_edge_is_kept() {
        let out = assemble(&[line("42", 0.5, 0.1, 0.14)]);
        assert_eq!(out, "42");
    }

    #[test]
    fn a_long_number_at_the_left_edge_is_kept() {
        // Seven digits is an amount or an id, not a line number.
        let out = assemble(&[line("1234567", 0.01, 0.1, 0.14)]);
        assert_eq!(out, "1234567");
    }

    #[test]
    fn three_increasing_left_edge_prefixes_are_stripped() {
        // The whitespace run in the prefix is capped at three characters, so a deeply indented
        // source line keeps whatever indentation is left over. The middle line has six spaces
        // after its number and comes back with three.
        let out = assemble(&[
            line("10  fn main() {", 0.02, 0.10, 0.14),
            line("11      let x = 1;", 0.02, 0.20, 0.24),
            line("12  }", 0.02, 0.30, 0.34),
        ]);
        assert_eq!(out, "fn main() {\n   let x = 1;\n}");
    }

    #[test]
    fn two_prefixes_are_not_enough_to_strip() {
        let out = assemble(&[line("10  alpha", 0.02, 0.1, 0.14), line("11  beta", 0.02, 0.2, 0.24)]);
        assert_eq!(out, "10  alpha\n11  beta");
    }

    #[test]
    fn prefixes_that_do_not_increase_are_not_stripped() {
        let out = assemble(&[
            line("3  alpha", 0.02, 0.1, 0.14),
            line("1  beta", 0.02, 0.2, 0.24),
            line("2  gamma", 0.02, 0.3, 0.34),
        ]);
        assert_eq!(out, "3  alpha\n1  beta\n2  gamma");
    }

    #[test]
    fn numbers_that_step_by_more_than_one_are_not_a_gutter() {
        // Increasing is not enough: a table of totals increases too.
        let out = assemble(&[
            line("10  alpha", 0.02, 0.1, 0.14),
            line("20  beta", 0.02, 0.2, 0.24),
            line("30  gamma", 0.02, 0.3, 0.34),
        ]);
        assert_eq!(out, "10  alpha\n20  beta\n30  gamma");
    }

    #[test]
    fn a_lone_numbered_line_at_the_left_edge_is_never_touched() {
        for text in ["404 Not Found", "2026-09-18 meeting", "1 + 2 = 3", "3 files changed"] {
            assert_eq!(assemble(&[line(text, 0.02, 0.1, 0.14)]), text, "line {text:?}");
        }
    }

    #[test]
    fn content_at_the_left_edge_survives_a_real_gutter_in_the_same_frame() {
        // The rule that matters: the gutter is real and its three lines are stripped, but a line
        // that merely starts with a number is not part of the run and keeps every character.
        // The previous implementation turned "404 Not Found" into "Not Found" here.
        let out = assemble(&[
            line("10  fn main() {", 0.02, 0.10, 0.14),
            line("11  let x = 1;", 0.02, 0.20, 0.24),
            line("12  }", 0.02, 0.30, 0.34),
            line("404 Not Found", 0.02, 0.40, 0.44),
            line("2026-09-18 meeting", 0.02, 0.50, 0.54),
            line("1 + 2 = 3", 0.02, 0.60, 0.64),
            line("3 files changed", 0.02, 0.70, 0.74),
            line("42", 0.02, 0.80, 0.84),
        ]);
        assert_eq!(
            out,
            "fn main() {\nlet x = 1;\n}\n404 Not Found\n2026-09-18 meeting\n1 + 2 = 3\n3 files changed\n42"
        );
    }

    // -- the lines the text is made of ----------------------------------------------------------

    #[test]
    fn a_cleaned_line_keeps_the_box_it_was_recognised_in() {
        // `cleaned` is what lets a caller say WHERE a line of the answer's text sat, so a stripped
        // line has to keep its own box and a dropped line has to take its box with it. The text is
        // `assemble`'s, character for character — that is the composition, not a coincidence.
        let raw = [
            line("1 fn main() {", 0.02, 0.10, 0.14),
            line("2 let x = 1;", 0.02, 0.20, 0.24),
            line("3 }", 0.02, 0.30, 0.34),
            line("42", 0.02, 0.40, 0.44),
        ];
        let kept = cleaned(&raw);
        assert_eq!(texts(&kept), ["fn main() {", "let x = 1;", "}", "42"]);
        for (index, line) in kept.iter().enumerate() {
            let box_of = |l: &Line| (l.x, l.right, l.top, l.bottom);
            assert_eq!(box_of(line), box_of(&raw[index]), "line {index}");
        }
        assert_eq!(join(&kept), assemble(&raw));

        // A gutter recognised as its own column: three lines dropped, three boxes gone with them.
        let column =
            [line("1", 0.02, 0.10, 0.14), line("2", 0.02, 0.20, 0.24), line("3", 0.02, 0.30, 0.34)];
        assert!(cleaned(&column).is_empty());
        assert_eq!(join(&cleaned(&column)), assemble(&column));
    }

    // -- what the gutter rule costs a numbered list --------------------------------------------
    //
    // These three pin the behaviour the comment on GUTTER_MIN_LINES describes. They are not an
    // aspiration: they record what the rule does today, so that the comment and the code can only
    // disagree by turning one of them red.

    #[test]
    fn a_bare_numbered_list_at_the_left_edge_loses_its_numerals() {
        // "1 Install / 2 Configure / 3 Run" hard against the left edge is three numbers stepping by
        // one with whitespace right after each digit — the exact shape of an editor's gutter. The
        // numerals go. This is the accepted cost, not a bug to be fixed by weakening the rule.
        let out = assemble(&[
            line("1 Install", 0.02, 0.10, 0.14),
            line("2 Configure", 0.02, 0.20, 0.24),
            line("3 Run", 0.02, 0.30, 0.34),
        ]);
        assert_eq!(out, "Install\nConfigure\nRun");
    }

    #[test]
    fn a_numbered_list_written_with_a_full_stop_keeps_its_numerals() {
        // The rule needs whitespace immediately after the digits; a full stop is not whitespace, so
        // none of these lines is a gutter candidate at all and every character survives.
        let out = assemble(&[
            line("1. Install", 0.02, 0.10, 0.14),
            line("2. Configure", 0.02, 0.20, 0.24),
            line("3. Run", 0.02, 0.30, 0.34),
        ]);
        assert_eq!(out, "1. Install\n2. Configure\n3. Run");
    }

    #[test]
    fn a_numbered_list_written_with_a_bracket_keeps_its_numerals() {
        let out = assemble(&[
            line("1) Install", 0.02, 0.10, 0.14),
            line("2) Configure", 0.02, 0.20, 0.24),
            line("3) Run", 0.02, 0.30, 0.34),
        ]);
        assert_eq!(out, "1) Install\n2) Configure\n3) Run");
    }

    #[test]
    fn a_number_that_breaks_the_run_is_not_stripped_and_does_not_join_it() {
        // "500 Server Error" sits between two halves of a gutter. Neither half is three long any
        // more, so nothing is stripped — under-stripping, never eating content.
        let out = assemble(&[
            line("10  alpha", 0.02, 0.1, 0.14),
            line("11  beta", 0.02, 0.2, 0.24),
            line("500 Server Error", 0.02, 0.3, 0.34),
            line("12  gamma", 0.02, 0.4, 0.44),
        ]);
        assert_eq!(out, "10  alpha\n11  beta\n500 Server Error\n12  gamma");
    }

    #[test]
    fn a_digit_run_away_from_the_gutter_is_never_stripped() {
        let out = assemble(&[
            line("10  fn main() {", 0.02, 0.10, 0.14),
            line("11  let x = 1;", 0.02, 0.20, 0.24),
            line("12  }", 0.02, 0.30, 0.34),
            line("404 not found", 0.50, 0.40, 0.44),
        ]);
        assert_eq!(out, "fn main() {\nlet x = 1;\n}\n404 not found");
    }

    #[test]
    fn nothing_is_padded_for_lines_that_were_never_recognised() {
        // Two lines far apart vertically still produce exactly two output lines.
        let out = assemble(&[line("top", 0.2, 0.02, 0.05), line("bottom", 0.2, 0.90, 0.93)]);
        assert_eq!(out.lines().count(), 2);
    }

    #[test]
    fn assembling_nothing_gives_an_empty_string() {
        assert_eq!(assemble(&[]), "");
    }
}
