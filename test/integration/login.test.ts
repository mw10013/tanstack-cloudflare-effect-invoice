import { Effect } from "effect";
import { describe, it } from "@effect/vitest";
import { expect } from "vitest";

import { login } from "@/lib/Login";

import { extractSessionCookie, workerFetch, resetDb, callServerFn } from "../TestUtils";

describe("integration smoke", () => {
  it.effect("renders /login", () =>
    Effect.gen(function*() {
      const response = yield* workerFetch("http://w/login");
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toContain("Sign in / Sign up");
    }));

  it.effect("login → verify magic link → access authenticated route", () =>
    Effect.gen(function*() {
      yield* resetDb();
      const result = yield* callServerFn({
        serverFn: login,
        data: { email: "u@u.com" },
      });
      expect(result.success).toBe(true);
      expect(result.magicLink).toContain("/api/auth/magic-link/verify");

      // Use `redirect: "manual"` because `exports.default.fetch` would otherwise
      // follow the first redirect to `/magic-link` without persisting the session
      // cookie from the 302 response like a browser cookie jar would.
      const verifyResponse = yield* workerFetch(result.magicLink ?? "", {
        redirect: "manual",
      });
      expect(verifyResponse.status).toBe(302);
      expect(new URL(verifyResponse.headers.get("location") ?? "").pathname).toBe(
        "/magic-link",
      );

      const sessionCookie = yield* extractSessionCookie(verifyResponse);
      expect(sessionCookie).toContain("better-auth.session_token=");

      const appResponse = yield* workerFetch(
        new URL(verifyResponse.headers.get("location") ?? "/", result.magicLink)
          .toString(),
        { headers: { Cookie: sessionCookie } },
      );
      expect(appResponse.status).toBe(200);
      expect(new URL(appResponse.url).pathname).toMatch(/^\/app\/.+/);
      expect(yield* Effect.promise(() => appResponse.text())).toContain("Members");
    }));

  it.effect("admin login → verify magic link → access admin route", () =>
    Effect.gen(function*() {
      yield* resetDb();
      const result = yield* callServerFn({
        serverFn: login,
        data: { email: "a@a.com" },
      });
      expect(result.success).toBe(true);
      expect(result.magicLink).toContain("/api/auth/magic-link/verify");

      const verifyResponse = yield* workerFetch(result.magicLink ?? "", {
        redirect: "manual",
      });
      expect(verifyResponse.status).toBe(302);
      expect(new URL(verifyResponse.headers.get("location") ?? "").pathname).toBe(
        "/magic-link",
      );

      const sessionCookie = yield* extractSessionCookie(verifyResponse);
      expect(sessionCookie).toContain("better-auth.session_token=");

      const appResponse = yield* workerFetch(
        new URL(verifyResponse.headers.get("location") ?? "/", result.magicLink)
          .toString(),
        { headers: { Cookie: sessionCookie } },
      );
      expect(appResponse.status).toBe(200);
      expect(new URL(appResponse.url).pathname).toBe("/admin");
      expect(yield* Effect.promise(() => appResponse.text())).toContain("Dashboard");
    }));
});
