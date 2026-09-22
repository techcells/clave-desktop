import {describe, expect, it} from "vitest";
import {luhnValid} from "./luhn";
import {scrub} from "./scrub";

describe("luhnValid", () => {
  it("accepts a valid test card and rejects a near miss", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
  });
});

describe("scrub: must match", () => {
  const cases: [string, string][] = [
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"],
    ["database connection string", "DATABASE_URL=postgres://app:s3cr3tpass@db.internal:5432/orders"],
    ["generic user:pass url", "https://deploy:hunter2hunter2@git.example.com/repo.git"],
    ["authorization header", "Authorization: Bearer abcdEFGH1234ijklMNOP5678"],
    ["openai-style key", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx12345678"],
    ["stripe key", "sk_live_51AbCdEfGhIjKlMnOpQrStUv"],
    ["github token", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"],
    ["slack token", "xoxb-123456789012-abcdefghijkl"],
    ["aws access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
    ["assignment", "password = correct-horse-battery"]
  ];
  it.each(cases)("%s becomes [SECRET]", (_name, input) => {
    const out = scrub(`before ${input} after`);
    expect(out.text).toContain("[SECRET]");
    expect(out.counts["[SECRET]"]).toBeGreaterThan(0);
  });

  it("labels emails, valid cards and clearly formatted phones", () => {
    expect(scrub("mail priya.raman@acme.io now").text).toBe("mail [EMAIL] now");
    expect(scrub("card 4242 4242 4242 4242 ok").text).toBe("card [CARD] ok");
    expect(scrub("call +1 (415) 555-0132 today").text).toBe("call [PHONE] today");
    expect(scrub("phone: 415-555-0132").text).toBe("phone: [PHONE]");
  });

  it("lets the secret win when a key looks like an email", () => {
    const out = scrub("dsn https://4f2a9c1b7d3e4f60a1b2c3d4e5f60718:secretpart99@o123.ingest.example.io/42");
    expect(out.text).toContain("[SECRET]");
    expect(out.text).not.toContain("secretpart99");
    expect(out.text).not.toContain("[EMAIL]");
  });

  it("labels a run-together international phone number (I4)", () => {
    expect(scrub("+15551234567").text).toBe("[PHONE]");
    expect(scrub("Call +447911123456 now").text).toBe("Call [PHONE] now");
  });
});

describe("scrub: must NOT match", () => {
  it.each([
    "order 48210412 shipped",
    "left: 47692, top: 1180, width: 1440",
    "2026-09-17T09:36:45.277Z",
    "version 2026.09.2 released",
    "commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
    "p95 rose from 310 ms to 2400 ms over 50,000 requests",
    "ticket PROJ-4821 and migration 0412",
    "192.168.10.24 responded in 12 ms",
    "4111 1111 1111 1112 is not a valid card number",
    "reference 4821-0412-7788 for the shipment",
    "+12345",
    "call 15551234567 now"
  ])("leaves %s untouched", (input) => {
    expect(scrub(input).text).toBe(input);
  });
});
