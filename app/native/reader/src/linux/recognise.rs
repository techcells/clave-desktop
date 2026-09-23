//! Recognition on Linux: where the models are, the one engine, and a captured window to lines.
//!
//! The models are `tessdata_best` `eng` and `por`, loaded as `por+eng`. They are looked for in the
//! directory named by `CLAVE_TESSDATA` (the app sets it, Task 5) and otherwise in `tessdata` beside
//! the helper binary (where the packages put them, Task 9), and used only if both match the SHA-256
//! pinned below: a mismatch means no recognition, never a guess with another model. The engine is
//! created on first use (the warm-up at start pays for it, hashing included) and shared: only the
//! worker recognises, and a lock keeps it so.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::prepare::prepare;
use super::tesseract::Engine;
use crate::frame::Frame;
use crate::text::Line;

/// The languages, Portuguese first: with English first the accents were lost (2026-09-23).
pub const LANGUAGES: &str = "por+eng";

/// The model files, with the SHA-256 of the `tessdata_best` copies the accuracy test passed with
/// (fetched 2026-09-23; `eng` 15,400,601 bytes, `por` 8,159,939 bytes).
pub const MODELS: [(&str, &str); 2] = [
    ("eng.traineddata", "8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba"),
    ("por.traineddata", "711de9dbb8052067bd42f16b9119967f30bada80d57e2ef24f65d09f531adb04"),
];

/// Where the models are: `CLAVE_TESSDATA` if set and not empty, else `tessdata` beside `exe`.
pub fn models_dir(variable: Option<&str>, exe: Option<&Path>) -> Option<PathBuf> {
    match variable.filter(|value| !value.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => exe.and_then(Path::parent).map(|dir| dir.join("tessdata")),
    }
}

/// The SHA-256 of a file, in lower-case hex, read in pieces. `None` when it cannot be read.
pub fn sha256_hex(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Whether every model file in `dir` is the pinned one.
pub fn models_verified(dir: &Path, models: &[(&str, &str)]) -> bool {
    models.iter().all(|(file, expected)| sha256_hex(&dir.join(file)).as_deref() == Some(*expected))
}

/// The engine, once made. `Err(())` remembers that it could not be made, so a broken install does
/// not pay the load again on every read.
static ENGINE: Mutex<Option<Result<Engine, ()>>> = Mutex::new(None);

fn with_engine<T>(work: impl FnOnce(&mut Engine) -> Result<T, ()>) -> Result<T, ()> {
    let mut slot = ENGINE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_none() {
        let exe = std::env::current_exe().ok();
        let variable = std::env::var("CLAVE_TESSDATA").ok();
        let engine = models_dir(variable.as_deref(), exe.as_deref())
            .filter(|dir| models_verified(dir, &MODELS))
            .and_then(|dir| Engine::new(&dir, LANGUAGES))
            .ok_or(());
        if engine.is_err() {
            // Once: the failure is remembered, so every read after this answers `recogniseError`.
            crate::runtime::note("E_MODELS");
        }
        *slot = Some(engine);
    }
    match slot.as_mut() {
        Some(Ok(engine)) => work(engine),
        _ => Err(()),
    }
}

/// Recognise a captured window: prepared as the accuracy test prepared its images, then read.
/// The line boxes are fractions of the image, so enlarging it does not change them.
pub fn lines(frame: &Frame, scale: f64) -> Result<Vec<Line>, ()> {
    let (grey, _) = prepare(frame, scale).ok_or(())?;
    with_engine(|engine| engine.recognise(&grey.data, grey.width, grey.height))
}

/// Pay the model load and the first recognition on an image made up in memory, never on the
/// user's screen. A failure is ignored: reads then answer `failed`, which is true.
pub fn warm_up() {
    let (width, height) = (400, 120);
    let mut grey = vec![0xf0u8; width * height];
    for (index, value) in grey.iter_mut().enumerate() {
        let (x, y) = (index % width, index / width);
        if (y / 8) % 3 == 0 && (x % 40) < 28 {
            *value = 0x20;
        }
    }
    let _ = with_engine(|engine| engine.recognise(&grey, width, height));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_models_come_from_the_variable_else_from_beside_the_helper() {
        let exe = Path::new("/opt/Clave Agent/resources/clave-reader");
        assert_eq!(models_dir(Some("/tmp/models"), Some(exe)), Some(PathBuf::from("/tmp/models")));
        assert_eq!(models_dir(None, Some(exe)), Some(PathBuf::from("/opt/Clave Agent/resources/tessdata")));
        assert_eq!(models_dir(Some(""), Some(exe)), Some(PathBuf::from("/opt/Clave Agent/resources/tessdata")), "empty is unset");
        assert_eq!(models_dir(None, None), None);
    }

    /// The Linux accuracy test again, now through the reader's own preparation, Tesseract binding
    /// and text assembly: every staged page of `app/reader-eval/linux/` (rendered in Linux Chromium,
    /// 1x and 2x, light and dark) must reach the thresholds of `src/readerEval/thresholds.ts`.
    /// Opt-in, because it needs the models and the rendered pages as PPM files:
    ///   CLAVE_TESSDATA=~/tessdata CLAVE_EVAL_IMAGES=<dir of *.ppm> OMP_THREAD_LIMIT=1 \
    ///     cargo test --release -- --ignored recognition_meets_the_thresholds --nocapture
    /// Prints scores and times only, never recognised text.
    #[test]
    #[ignore]
    fn recognition_meets_the_thresholds() {
        let images = PathBuf::from(std::env::var("CLAVE_EVAL_IMAGES").expect("CLAVE_EVAL_IMAGES"));
        let truth_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reader-eval/truth");
        let thresholds = [("chat", 0.97), ("ticket", 0.97), ("terminal", 0.95), ("pt", 0.95), ("code", 0.90)];
        let mut worst: std::collections::BTreeMap<String, (f64, f64)> = std::collections::BTreeMap::new();
        let mut times = Vec::new();
        let mut names: Vec<_> = std::fs::read_dir(&images).unwrap().map(|entry| entry.unwrap().path()).collect();
        names.sort();
        for path in names.iter().filter(|path| path.extension().is_some_and(|ext| ext == "ppm")) {
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let group = name.split(['-', '@']).next().unwrap().to_owned();
            let scale = if name.ends_with("@2x") { 2.0 } else { 1.0 };
            let frame = read_ppm_as_bgrx(&std::fs::read(path).unwrap());
            let started = std::time::Instant::now();
            let lines = lines(&frame, scale).expect("recognised");
            times.push(started.elapsed().as_millis());
            let text = crate::text::assemble(&crate::text::order(lines));
            let truth = std::fs::read_to_string(truth_dir.join(format!("{group}.txt"))).unwrap();
            let body = between_markers(&text);
            let (accuracy, accents) = body.map_or((0.0, 0.0), |body| (accuracy(body, &truth), accents(body, &truth)));
            println!("{name:24} accuracy {accuracy:.3} accents {accents:.2} {} ms", times.last().unwrap());
            let entry = worst.entry(group).or_insert((1.0, 1.0));
            entry.0 = entry.0.min(accuracy);
            entry.1 = entry.1.min(accents);
        }
        times.sort();
        println!("median {} ms, max {} ms, over {} pages", times[times.len() / 2], times[times.len() - 1], times.len());
        for (group, bar) in thresholds {
            let (accuracy, accents) = worst[group];
            println!("{group:9} min {accuracy:.3} (bar {bar}){}", if group == "pt" { format!(", accents {accents:.2} (bar 1.00)") } else { String::new() });
            assert!(accuracy >= bar, "{group} {accuracy} below {bar}");
            if group == "pt" {
                assert!(accents >= 1.0, "pt accents {accents}");
            }
        }
    }

    fn read_ppm_as_bgrx(bytes: &[u8]) -> Frame {
        let mut fields = Vec::new();
        let mut at = 0;
        while fields.len() < 4 {
            while bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            let start = at;
            while !bytes[at].is_ascii_whitespace() {
                at += 1;
            }
            fields.push(String::from_utf8_lossy(&bytes[start..at]).to_string());
        }
        assert_eq!(fields[0], "P6");
        let (width, height): (usize, usize) = (fields[1].parse().unwrap(), fields[2].parse().unwrap());
        let pixels = &bytes[at + 1..at + 1 + width * height * 3];
        let data = pixels.chunks_exact(3).flat_map(|rgb| [rgb[2], rgb[1], rgb[0], 0xff]).collect();
        Frame { width, height, bytes_per_row: width * 4, bytes_per_pixel: 4, data }
    }

    fn between_markers(text: &str) -> Option<&str> {
        let upper = text.to_ascii_uppercase();
        let start = upper.find("STARTMARKER")? + "STARTMARKER".len();
        let end = upper.rfind("ENDMARKER")?;
        (end >= start && upper.is_char_boundary(start)).then(|| &text[start..end])
    }

    fn norm(text: &str) -> Vec<char> {
        text.split_whitespace().collect::<Vec<_>>().join(" ").chars().collect()
    }

    fn accuracy(ocr: &str, truth: &str) -> f64 {
        let (o, t) = (norm(ocr), norm(truth));
        let mut previous: Vec<usize> = (0..=o.len()).collect();
        for i in 1..=t.len() {
            let mut current = vec![i];
            for j in 1..=o.len() {
                current.push((previous[j] + 1).min(current[j - 1] + 1).min(previous[j - 1] + usize::from(t[i - 1] != o[j - 1])));
            }
            previous = current;
        }
        (1.0 - previous[o.len()] as f64 / t.len().max(1) as f64).max(0.0)
    }

    fn accents(ocr: &str, truth: &str) -> f64 {
        let accented = "áàâãçéêíóôõúÁÀÂÃÇÉÊÍÓÔÕÚ";
        let (mut want, mut got) = (0, 0);
        for character in accented.chars() {
            let in_truth = truth.matches(character).count();
            want += in_truth;
            got += ocr.matches(character).count().min(in_truth);
        }
        if want == 0 { 1.0 } else { got as f64 / want as f64 }
    }

    #[test]
    fn the_hash_is_sha256() {
        // FIPS 180-2 test vectors: "abc", and the empty message.
        let dir = std::env::temp_dir().join(format!("clave-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("abc"), b"abc").unwrap();
        std::fs::write(dir.join("empty"), b"").unwrap();
        assert_eq!(sha256_hex(&dir.join("abc")).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha256_hex(&dir.join("empty")).unwrap(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(&dir.join("missing")), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_both_models_with_their_pinned_hashes_are_used() {
        let dir = std::env::temp_dir().join(format!("clave-models-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pinned = [
            ("eng.traineddata", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            ("por.traineddata", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
        ];
        assert!(!models_verified(&dir, &pinned), "none there");
        std::fs::write(dir.join("eng.traineddata"), b"abc").unwrap();
        assert!(!models_verified(&dir, &pinned), "one of two");
        std::fs::write(dir.join("por.traineddata"), b"not empty").unwrap();
        assert!(!models_verified(&dir, &pinned), "a changed file");
        std::fs::write(dir.join("por.traineddata"), b"").unwrap();
        assert!(models_verified(&dir, &pinned));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
