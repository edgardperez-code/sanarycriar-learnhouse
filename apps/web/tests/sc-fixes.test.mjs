// Sanar y Criar: cross-cutting fixes from the phase-1 reviews.
//  - proxy.ts sends a signed-in visitor on /login (or /signup on an org-less
//    host) to the sanitized ?redirect / ?next instead of always /home, and a
//    short-lived cookie stops a /login <-> page redirect loop.
//  - the archive-offer dialog finds the courses that would become free.
// All fixtures are synthetic.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

let instance = { tenancy: "single", default_org_slug: "sanarycriar", mode: "oss", frontend_domain: "localhost:3200", top_domain: "localhost" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes("instance/info")) {
    return new Response(JSON.stringify(instance), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { default: proxy } = await import("../proxy.ts");
const { safeInternalPath } = await import("../services/security/url.ts");
const { safeRedirectPath, withRedirect } = await import("../components/Payments/commerce.ts");
const { resourcesOnlyCoveredBy } = await import(
  "../components/Dashboard/Pages/Payments/SubComponents/ArchiveOfferDialog.tsx"
);

function visit(path, cookies = { LH_session: "1" }) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return proxy(new NextRequest(`http://localhost:3200${path}`, { headers: cookie ? { cookie } : {} }));
}

const location = (res) => {
  const value = res.headers.get("location");
  if (!value) return null;
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
};

describe("signed-in visitor on /login", () => {
  beforeEach(() => {
    instance = { ...instance, tenancy: "single" };
  });

  test("goes back to ?redirect", async () => {
    const res = await visit("/login?redirect=%2Fstore%2Foffers%2Fabc%3Fx%3D1");
    expect(res.status).toBe(307);
    expect(location(res)).toBe("/store/offers/abc?x=1");
    expect(res.headers.get("set-cookie")).toContain("sc_auth_bounce=1");
  });

  test("also honors ?next", async () => {
    expect(location(await visit("/login?next=%2Fcourse%2Fxyz"))).toBe("/course/xyz");
  });

  test("falls back to /home without a usable redirect", async () => {
    for (const q of ["", "?redirect=", "?redirect=https%3A%2F%2Fevil.example", "?redirect=%2F%2Fevil.example",
                     "?redirect=%2F%09%2Fevil.example", "?redirect=%2F%5Cevil.example", "?redirect=javascript%3Aalert(1)",
                     "?redirect=%2Flogin%3Fredirect%3D%2Fx", "?redirect=%2Fsignup"]) {
      const res = await visit(`/login${q}`);
      expect(location(res)).toBe("/home");
      expect(res.headers.get("set-cookie") ?? "").not.toContain("sc_auth_bounce");
    }
  });

  test("a second bounce in a row goes to /home (no redirect loop)", async () => {
    const res = await visit("/login?redirect=%2Fboards", { LH_session: "1", sc_auth_bounce: "1" });
    expect(location(res)).toBe("/home");
  });

  test("a pending second factor still renders the login page", async () => {
    const res = await visit("/login?mfa_token=t&redirect=%2Fboards");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toContain("/auth/login");
  });

  test("signed-out visitors get the login page", async () => {
    const res = await visit("/login?redirect=%2Fboards", {});
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toContain("/auth/login");
  });

  test("/signup on a single-tenant host stays the join screen", async () => {
    const res = await visit("/signup?redirect=%2Fcourse%2Fxyz");
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toContain("/auth/signup");
  });
});

describe("resourcesOnlyCoveredBy", () => {
  const offers = [
    { id: 1, resource_uuids: ["course_a", "course_b"] },
    { id: 2, resource_uuids: ["course_b"] },
    { id: 3, resource_uuids: ["c"] },
    { id: 4, archived: true, resource_uuids: ["course_a"] },
  ];

  test("lists only the courses no other active offer covers", () => {
    expect(resourcesOnlyCoveredBy(offers[0], offers)).toEqual(["course_a"]);
    expect(resourcesOnlyCoveredBy(offers[1], offers)).toEqual([]);
    expect(resourcesOnlyCoveredBy(offers[2], offers)).toEqual(["course_c"]);
  });

  test("compares uuids with or without the course_ prefix", () => {
    const list = [{ id: "9", resource_uuids: ["x"] }, { id: 10, resource_uuids: ["course_x"] }];
    expect(resourcesOnlyCoveredBy(list[0], list)).toEqual([]);
  });

  test("an offer without courses frees nothing", () => {
    expect(resourcesOnlyCoveredBy({ id: 5 }, offers)).toEqual([]);
  });
});

// Sanar y Criar: open redirects through dot segments (security review,
// docs/progreso/seguridad.md). "/..//evil.com" passes a "starts with one
// slash" test but normalizes to "//evil.com", a protocol-relative URL.
describe("dot-segment open redirects", () => {
  const payloads = ["/..//evil.com", "/a/..//evil.com", "/.//evil.com", "/./%2Fevil.com", "/%2E%2E//evil.com", "/..///evil.com/x"];

  test("safeInternalPath never yields a path that starts with //", () => {
    for (const value of payloads) {
      const out = safeInternalPath(new URLSearchParams(`r=${encodeURIComponent(value)}`).get("r"), "/home");
      expect(out.startsWith("//")).toBe(false);
      expect(new URL(out, "http://localhost:3200/").host).toBe("localhost:3200");
    }
    // The decoded "%2F" form a query string hands back.
    expect(safeInternalPath(new URLSearchParams("r=/./%2Fevil.com").get("r"), "/home")).toBe("/home");
    expect(safeInternalPath("/..//evil.com", "/home")).toBe("/home");
    expect(safeInternalPath("/a/..//evil.com", "/home")).toBe("/home");
    expect(safeInternalPath("/.//evil.com", "/home")).toBe("/home");
  });

  test("normal paths keep working (normalized)", () => {
    expect(safeInternalPath("/store/offers/abc?x=1#y")).toBe("/store/offers/abc?x=1#y");
    expect(safeInternalPath("/course/a/../b")).toBe("/course/b");
    expect(safeRedirectPath("/..//evil.com")).toBeNull();
    expect(withRedirect("/signup", "/..//evil.com")).toBe("/signup");
  });

  test("signed-in bounce on /login stays on this host", async () => {
    for (const q of ["/..//evil.com", "/a/..//evil.com", "/./%2Fevil.com"]) {
      const res = await visit(`/login?redirect=${q}`);
      const target = new URL(res.headers.get("location"), "http://localhost:3200/");
      expect(target.host).toBe("localhost:3200");
      expect(location(res)).toBe("/home");
    }
  });

  test("/redirect_from_auth never leaves the host, without a session", async () => {
    for (const q of ["%2F..%2F%2Fevil.example%2Fx", "/./%2Fevil.example", "/a/..//evil.example", "//evil.example"]) {
      const res = await visit(`/redirect_from_auth?next=${q}`, {});
      const value = res.headers.get("location");
      expect(value).not.toBeNull();
      expect(new URL(value, "http://localhost:3200/").host).toBe("localhost:3200");
    }
    // A normal deep link still lands where it was going.
    const ok = await visit(`/redirect_from_auth?next=${encodeURIComponent("/store/offers/abc")}`, {});
    expect(location(ok)).toContain("/store/offers/abc");
  });
});
