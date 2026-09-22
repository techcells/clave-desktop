export interface Token { raw: string; norm: string }

/** Letters and digits, plus + # and inner dots, so C++, C# and Node.js survive. Hyphens split. */
const TOKEN = /(?<![\p{L}\p{N}])\.?[\p{L}\p{N}][\p{L}\p{N}+#.]*/gu;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0].replace(/\.+$/, "");
    if (raw && raw !== ".") tokens.push({raw, norm: raw.toLowerCase()});
  }
  return tokens;
}

export function normalisePhrase(name: string): string {
  return tokenize(name).map((t) => t.norm).join(" ");
}
