import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totp, verifyTotp } from "@/lib/auth/totp";

// RFC 6238 appendix B: SHA-1 secret "12345678901234567890", 8-digit codes.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("totp", () => {
  it("matches the RFC 6238 test vectors", () => {
    for (const [seconds, code] of VECTORS) expect(totp(RFC_SECRET, seconds * 1000, 8)).toBe(code);
  });

  it("encodes and decodes base32", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it("accepts one step either side and nothing further", () => {
    const now = 1_700_000_000_000;
    const at = (offset: number) => totp(RFC_SECRET, now + offset * 30_000);
    expect(verifyTotp(RFC_SECRET, at(0), now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(-1), now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(1), now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, at(2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, at(-2), now)).toBeNull();
  });

  it("rejects malformed codes", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(RFC_SECRET, "", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, `${totp(RFC_SECRET, now)}0`, now)).toBeNull();
  });

  it("tolerates a space in the middle of the code", () => {
    const now = 1_700_000_000_000;
    const code = totp(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).not.toBeNull();
  });

  it("builds the otpauth link", () => {
    const uri = new URL(otpauthUri({ secret: "ABCDEF234567", account: "a+b@example.com", issuer: "OW Slido" }));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.host).toBe("totp");
    expect(decodeURIComponent(uri.pathname)).toBe("/OW Slido:a+b@example.com");
    expect(uri.searchParams.get("secret")).toBe("ABCDEF234567");
    expect(uri.searchParams.get("issuer")).toBe("OW Slido");
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(uri.searchParams.get("period")).toBe("30");
  });
});
