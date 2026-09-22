# Tesseract through its C API, the engine loaded once as the app would, in four configurations:
# packaged (fast) or best models, with or without preparing the image first.
# LANGS sets the language order ("por+eng" passed; "eng+por" lost accents). OMP_THREAD_LIMIT=1 is
# the background-agent case.
import ctypes, glob, json, os, statistics, time
from PIL import Image, ImageOps, ImageStat

LANGS = os.environ.get("LANGS", "por+eng")
THREADS = os.environ.get("OMP_THREAD_LIMIT", "all")
OUT = "/w/out/linux"
REPEATS = 3

T = ctypes.CDLL("libtesseract.so.5")
T.TessBaseAPICreate.restype = ctypes.c_void_p
T.TessBaseAPIInit3.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
T.TessBaseAPISetPageSegMode.argtypes = [ctypes.c_void_p, ctypes.c_int]
T.TessBaseAPISetImage.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int]
T.TessBaseAPISetSourceResolution.argtypes = [ctypes.c_void_p, ctypes.c_int]
T.TessBaseAPIGetUTF8Text.argtypes = [ctypes.c_void_p]
T.TessBaseAPIGetUTF8Text.restype = ctypes.POINTER(ctypes.c_char)
T.TessDeleteText.argtypes = [ctypes.POINTER(ctypes.c_char)]
T.TessBaseAPIDelete.argtypes = [ctypes.c_void_p]

CONFIGS = {
    "fast-raw": ("/usr/share/tesseract-ocr/5/tessdata", False),
    "fast-prepared": ("/usr/share/tesseract-ocr/5/tessdata", True),
    "best-raw": ("/best", False),
    "best-prepared": ("/best", True),
}


def engine(datapath):
    api = T.TessBaseAPICreate()
    started = time.perf_counter()
    if T.TessBaseAPIInit3(api, datapath.encode(), LANGS.encode()) != 0:
        raise SystemExit(f"tesseract could not load {LANGS} from {datapath}")
    T.TessBaseAPISetPageSegMode(api, 3)  # fully automatic page segmentation
    return api, (time.perf_counter() - started) * 1000


def recognise(api, image):
    gray = image.convert("L")
    T.TessBaseAPISetImage(api, gray.tobytes(), gray.width, gray.height, 1, gray.width)
    T.TessBaseAPISetSourceResolution(api, 144)
    text = T.TessBaseAPIGetUTF8Text(api)
    try:
        return ctypes.string_at(text).decode("utf-8", "replace")
    finally:
        T.TessDeleteText(text)


def prepare(image, scale):
    """Grayscale, dark themes inverted to dark-on-light, and 1x images enlarged to 2x."""
    gray = image.convert("L")
    if ImageStat.Stat(gray).mean[0] < 128:
        gray = ImageOps.invert(gray)
    if scale == 1:
        gray = gray.resize((gray.width * 2, gray.height * 2), Image.LANCZOS)
    return gray


results = {"langs": LANGS, "threads": THREADS, "loadMs": {}, "reads": {}}
images = sorted(glob.glob(f"{OUT}/img/*.png"))
if not images:
    raise SystemExit("no images: run render.py first")
for name, (datapath, prepared) in CONFIGS.items():
    api, load_ms = engine(datapath)
    results["loadMs"][name] = round(load_ms)
    for path in images:
        case = os.path.basename(path)[:-4]
        scale = 2 if case.endswith("@2x") else 1
        image = Image.open(path)
        image.load()
        times = []
        for _ in range(REPEATS):
            started = time.perf_counter()
            text = recognise(api, prepare(image, scale) if prepared else image)
            times.append((time.perf_counter() - started) * 1000)
        results["reads"].setdefault(case, {})[name] = {"text": text, "ms": round(statistics.median(times))}
    T.TessBaseAPIDelete(api)
    print(f"{name} done ({LANGS}, threads {THREADS})", flush=True)
with open(f"{OUT}/tesseract-{LANGS}-threads-{THREADS}.json", "w") as f:
    json.dump(results, f, ensure_ascii=False)
