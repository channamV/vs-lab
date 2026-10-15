import { afterEach, describe, expect, it, vi } from "vitest";
import { isCorrectPassword, isValidSession, sessionToken } from "./auth";

afterEach(() => vi.unstubAllEnvs());

describe("auth", () => {
  it("is open on your own PC when no password is set", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "");
    vi.stubEnv("VERCEL", "");
    expect(await isValidSession(undefined)).toBe(true);
  });

  it("stays locked on Vercel when no password is set", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "");
    vi.stubEnv("VERCEL", "1");
    expect(await isValidSession(undefined)).toBe(false);
    expect(await isCorrectPassword("")).toBe(false);
  });

  it("requires the password when one is set", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "correct horse battery staple");
    vi.stubEnv("VERCEL", "1");
    expect(await isValidSession(undefined)).toBe(false);
    expect(await isValidSession("wrong")).toBe(false);
    expect(await isValidSession(await sessionToken())).toBe(true);
    expect(await isCorrectPassword("nope")).toBe(false);
    expect(await isCorrectPassword("correct horse battery staple")).toBe(true);
  });
});
