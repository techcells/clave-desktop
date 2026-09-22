/** Names that are also ordinary words. Each needs exact casing AND its hint somewhere in the scenario. */
const HINTS: Record<string, RegExp> = {
  go: /\.go\b|\bgo (build|run|mod|test|get|vet)\b|\bgolang\b|\bgoroutine/i,
  swift: /\.swift\b|\bswiftui\b|\bxcode\b|\buikit\b/i,
  rust: /\.rs\b|\bcargo (build|run|test|add)\b|\brustc\b|\bcrate\b/i,
  react: /\.(jsx|tsx)\b|\buse(State|Effect|Memo|Ref|Callback)\b|\breact-dom\b|\bjsx\b/,
  spring: /\bspring boot\b|springframework|@SpringBootApplication|@RestController/i,
  express: /express\(\)|require\(['"]express['"]\)|from ['"]express['"]|\bapp\.(get|post|use)\(/,
  flask: /from flask\b|\bflask run\b|@app\.route/i,
  dart: /\.dart\b|\bflutter\b|\bpubspec\b/i,
  make: /\bmakefile\b|\bmake (install|build|clean|test)\b/i,
  excel: /\.xlsx?\b|\bspreadsheet|\bworkbook\b|\bpivot table|\bvlookup\b/i,
  word: /\.docx?\b/i,
  access: /\.accdb\b|\bms access\b/i,
  unity: /\.unity\b|\bgameobject\b|\bmonobehaviour\b/i,
  sketch: /\.sketch\b|\bartboard/i,
  notion: /notion\.so\b|\bnotion (page|database|workspace)\b/i,
  linear: /linear\.app\b|\blinear (issue|ticket|cycle)\b/i,
  r: /\.(R|Rmd)\b|\brstudio\b|\bggplot|\bdplyr\b|\btidyverse\b|\bcran\b/i,
  c: /\.(c|h)\b|\bgcc\b|\bclang\b|\bmalloc\b|\bprintf\(/
};

export type Strictness = "plain" | "exactCase" | "exactCaseAndHint";

export function strictnessOf(normName: string): Strictness {
  if (Object.hasOwn(HINTS, normName) || [...normName].length === 1) return "exactCaseAndHint";
  if (!normName.includes(" ") && [...normName].length <= 3) return "exactCase";
  return "plain";
}

export function hintPresent(normName: string, scenarioText: string): boolean {
  const hint = Object.hasOwn(HINTS, normName) ? HINTS[normName] : undefined;
  return hint ? hint.test(scenarioText) : false;
}
