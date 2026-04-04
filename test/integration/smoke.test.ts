import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { login } from "@/lib/Login";

import { extractSessionCookie, resetDb, runServerFn } from "../test-utils";

describe("integration smoke", () => {
  it("renders /login", async () => {
    const response = await exports.default.fetch("http://example.com/login");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in / Sign up");
  });

  it("login → verify magic link → access authenticated route", async () => {
    await resetDb();
    const result = await runServerFn({
      serverFn: login,
      data: { email: "u@u.com" },
    });
    expect(result.success).toBe(true);
    expect(result.magicLink).toContain("/api/auth/magic-link/verify");

    // Use `redirect: "manual"` because `exports.default.fetch` would otherwise
    // follow the first redirect to `/magic-link` without persisting the session
    // cookie from the 302 response like a browser cookie jar would.
    const verifyResponse = await exports.default.fetch(result.magicLink ?? "", {
      redirect: "manual",
    });
    expect(verifyResponse.status).toBe(302);
    expect(new URL(verifyResponse.headers.get("location") ?? "").pathname).toBe(
      "/magic-link",
    );

    const sessionCookie = extractSessionCookie(verifyResponse);
    expect(sessionCookie).toContain("better-auth.session_token=");

    const appResponse = await exports.default.fetch(
      new URL(verifyResponse.headers.get("location") ?? "/", result.magicLink)
        .toString(),
      {
        headers: { Cookie: sessionCookie },
      },
    );
    expect(appResponse.status).toBe(200);
    expect(new URL(appResponse.url).pathname).toMatch(/^\/app\/.+/);
    expect(await appResponse.text()).toContain("Members");
  });
});
