// Behaviour tests for the signup gateway (app/api/signup).
//
// Covers the two anti-abuse gaps: the backend's per-IP signup limit only works
// if the caller's IP is relayed, and the custom-domain Turnstile skip must only
// cover signups into the org that owns that domain. All fixtures are synthetic.

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

let customDomainOrgId = null;
const turnstileCalls = [];

mock.module("@lib/saas", () => ({
  isSaaSMode: async () => true,
  getCustomDomainOrgId: async () => customDomainOrgId,
  isCustomDomainRequest: async () => customDomainOrgId !== null,
}));

mock.module("@lib/turnstile", () => ({
  verifyTurnstile: async (token) => {
    turnstileCalls.push(token);
    return token ? { ok: true } : { ok: false, reason: "missing_token" };
  },
  clientIpFromHeaders: () => undefined,
}));

mock.module("@services/config/config", () => ({
  getServerAPIUrl: () => "http://api.test/api/v1/",
}));

mock.module("@services/emails/disposableEmail", () => ({
  validateSignupEmail: async () => ({ ok: true }),
}));

const loopsEvents = [];
mock.module("@services/emails/loops", () => ({
  addContactWithLoops: async () => ({}),
  sendLoopsEvent: async (email, eventName, eventProperties) => {
    loopsEvents.push({ email, eventName, eventProperties });
    return {};
  },
  LOOPS_SIGNED_USERS_GROUP: "test",
}));

const backendCalls = [];
// What the backend answers a signup (the created UserRead).
let backendAnswer = { id: 1 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  backendCalls.push({ url: String(url), init });
  return new Response(JSON.stringify(backendAnswer), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { POST } = await import("../app/api/signup/route.ts");

function signup(body, headers = {}) {
  return POST(
    new Request("https://example.test/api/signup", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        email: "new.user@example.test",
        password: "a-long-test-password",
        username: "newuser",
        ...body,
      }),
    }),
  );
}

beforeEach(() => {
  customDomainOrgId = null;
  turnstileCalls.length = 0;
  backendCalls.length = 0;
  loopsEvents.length = 0;
  backendAnswer = { id: 1 };
});

describe("client IP relay", () => {
  test("forwards X-Forwarded-For and X-Real-IP to the backend", async () => {
    const res = await signup(
      { turnstileToken: "tok" },
      { "x-forwarded-for": "203.0.113.7, 10.0.0.2", "x-real-ip": "203.0.113.7" },
    );
    expect(res.status).toBe(200);
    expect(backendCalls).toHaveLength(1);
    const sent = new Headers(backendCalls[0].init.headers);
    expect(sent.get("x-forwarded-for")).toBe("203.0.113.7, 10.0.0.2");
    expect(sent.get("x-real-ip")).toBe("203.0.113.7");
    expect(sent.get("content-type")).toBe("application/json");
  });

  test("sends no IP headers the caller didn't have", async () => {
    await signup({ turnstileToken: "tok" });
    const sent = new Headers(backendCalls[0].init.headers);
    expect(sent.has("x-forwarded-for")).toBe(false);
    expect(sent.has("x-real-ip")).toBe(false);
  });
});

describe("Turnstile on custom domains", () => {
  test("platform host: a missing token is rejected", async () => {
    const res = await signup({ org_id: 7 });
    expect(res.status).toBe(403);
    expect(backendCalls).toHaveLength(0);
  });

  test("custom domain: signing up into the domain's own org skips the challenge", async () => {
    customDomainOrgId = 7;
    const res = await signup({ org_id: 7 });
    expect(res.status).toBe(200);
    expect(turnstileCalls).toHaveLength(0);
    expect(backendCalls[0].url).toBe("http://api.test/api/v1/users/7");
  });

  test("custom domain: an org-less signup still needs the challenge", async () => {
    customDomainOrgId = 7;
    const res = await signup({});
    expect(res.status).toBe(403);
    expect(backendCalls).toHaveLength(0);
  });

  test("custom domain: a signup into a different org still needs the challenge", async () => {
    customDomainOrgId = 7;
    const res = await signup({ org_id: "8" });
    expect(res.status).toBe(403);
    expect(backendCalls).toHaveLength(0);
  });
});

// Sanar y Criar: the /regalo sign-up sends where the verification email
// should return (contract "regalo" §B2); the backend validates the path.
describe("return_path", () => {
  const sentBody = () => JSON.parse(backendCalls[0].init.body);

  test("a string reaches the backend body as is", async () => {
    const path = "/regalo?resultado=limites&origen=test";
    const res = await signup({ turnstileToken: "tok", org_id: 7, return_path: path });
    expect(res.status).toBe(200);
    expect(sentBody().return_path).toBe(path);
  });

  test("absent, empty or not a string: not sent (the sign-up never fails for it)", async () => {
    for (const value of [undefined, "", 42, ["/regalo"], { path: "/regalo" }, null]) {
      backendCalls.length = 0;
      const res = await signup({ turnstileToken: "tok", org_id: 7, return_path: value });
      expect(res.status).toBe(200);
      expect("return_path" in sentBody()).toBe(false);
    }
  });
});

// Sanar y Criar: the sign-up forms no longer ask for a username (client
// request 2026-11-05); the backend generates one when none is sent.
describe("username is optional", () => {
  const sentBody = () => JSON.parse(backendCalls[0].init.body);

  test("no username: forwarded to the backend without one, not refused with a 400", async () => {
    const res = await signup({ turnstileToken: "tok", org_id: 7, username: undefined });
    expect(res.status).toBe(200);
    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0].url).toBe("http://api.test/api/v1/users/7");
    expect("username" in sentBody()).toBe(false);
  });

  test("empty or not a string: left out as well", async () => {
    for (const value of ["", null, 42, ["ana"], { name: "ana" }]) {
      backendCalls.length = 0;
      const res = await signup({ turnstileToken: "tok", org_id: 7, username: value });
      expect(res.status).toBe(200);
      expect("username" in sentBody()).toBe(false);
    }
  });

  test("a username that is sent still reaches the backend as is", async () => {
    await signup({ turnstileToken: "tok", org_id: 7, username: "Ana_Admin" });
    expect(sentBody().username).toBe("Ana_Admin");
  });

  test("the form's body without username or bio keeps every other field", async () => {
    const res = await signup({
      turnstileToken: "tok",
      org_id: 7,
      username: undefined,
      first_name: "María",
      last_name: "Peña",
      custom_fields: { pais: "Venezuela" },
      return_path: "/regalo?resultado=guia&origen=test",
    });
    expect(res.status).toBe(200);
    expect(sentBody()).toEqual({
      email: "new.user@example.test",
      password: "a-long-test-password",
      first_name: "María",
      last_name: "Peña",
      custom_fields: { pais: "Venezuela" },
      return_path: "/regalo?resultado=guia&origen=test",
    });
  });

  test("the invite and org-less signups go through without one too", async () => {
    await signup({ turnstileToken: "tok", org_id: 7, inviteCode: "CODE", username: undefined });
    await signup({ turnstileToken: "tok", username: undefined });
    expect(backendCalls.map((c) => c.url)).toEqual([
      "http://api.test/api/v1/users/7/invite/CODE",
      "http://api.test/api/v1/users/",
    ]);
    for (const call of backendCalls) expect("username" in JSON.parse(call.init.body)).toBe(false);
  });

  test("email and password are still required", async () => {
    expect((await signup({ turnstileToken: "tok", username: undefined, email: "" })).status).toBe(400);
    expect((await signup({ turnstileToken: "tok", username: undefined, password: "" })).status).toBe(400);
    expect(backendCalls).toHaveLength(0);
  });

  test("the marketing event carries the username the backend generated", async () => {
    backendAnswer = { id: 1, username: "mariapena123456" };
    await signup({ turnstileToken: "tok", username: undefined });
    expect(loopsEvents).toEqual([
      {
        email: "new.user@example.test",
        eventName: "user_signed_up",
        eventProperties: { username: "mariapena123456", has_org: false },
      },
    ]);
  });
});
