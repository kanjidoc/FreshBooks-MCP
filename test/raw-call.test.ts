import { describe, it, expect } from "vitest";
import type { Client } from "@freshbooks/api";
import { runInProfile, type ProfileState } from "../src/profiles";
import {
  buildRawQuery,
  unwrapEnvelope,
  EnvelopeDriftError,
  readPageMeta,
  decodeReportParams,
  rawRequest,
  rawList,
  renderRaw,
  type RawFailure,
  type RawListResult,
} from "../src/raw-call";

/* ------------------------------------------------------------------ *
 * Fakes (T2): profile.client short-circuits getOrCreateClient, so no
 * env vars, no network, no refresh. Fake call() MUST have arity 5 or
 * asRawCallable rejects it — that is part of the contract under test.
 * ------------------------------------------------------------------ */

type CallFn = (method: string, url: string, config: object, data: unknown, name: string) => any;

function makeProfile(name: string, call: CallFn): ProfileState {
  return {
    name,
    filePath: `/nonexistent/${name}.env`,
    config: { accessToken: "a", refreshToken: "r", accountId: "ACC", businessId: "" },
    client: { call } as unknown as Client,
    refreshInFlight: null,
  };
}

const inProfile = <T>(call: CallFn, fn: () => Promise<T>): Promise<T> =>
  runInProfile(makeProfile("test", call), fn);

/** A paged accounting collection under envelope key "things". */
function pagedCall(
  pages: unknown[][],
  opts: {
    total?: number;
    pagesTotal?: number;
    echoPage?: (p: number) => number;
    delayMs?: number;
    urls?: string[];
  } = {},
): CallFn {
  const total = opts.total ?? pages.flat().length;
  return async (_m: string, url: string, _c: object, _d: unknown, _n: string) => {
    opts.urls?.push(url);
    const page = Number(new URL(`http://x${url}`).searchParams.get("page"));
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return {
      ok: true,
      data: {
        response: {
          result: {
            things: pages[page - 1] ?? [],
            page: opts.echoPage ? opts.echoPage(page) : page,
            pages: opts.pagesTotal ?? pages.length,
            per_page: 100,
            total,
          },
        },
      },
    };
  };
}

const expectFailure = (r: unknown, kind: string): RawFailure => {
  const f = r as RawFailure;
  expect(f.ok).toBe(false);
  expect(f.kind).toBe(kind);
  expect(typeof f.message).toBe("string");
  expect(f.message.length).toBeGreaterThan(0); // non-empty message is a property
  return f;
};

/* ------------------------------------------------------------------ *
 * Pure builders (T1)
 * ------------------------------------------------------------------ */

describe("buildRawQuery", () => {
  it("emits scalars, percent-encodes, omits undefined", () => {
    expect(buildRawQuery({ a: 1, b: "x y", c: true, d: undefined })).toBe("?a=1&b=x+y&c=true");
  });
  it("emits arrays as repeated key[] pairs", () => {
    expect(buildRawQuery({ "dates[]": ["2025-01-01", "2025-06-30"] })).toBe(
      "?dates%5B%5D=2025-01-01&dates%5B%5D=2025-06-30",
    );
  });
  it("rejects an array under a key without the [] suffix", () => {
    expect(() => buildRawQuery({ dates: ["2025-01-01"] })).toThrow(/dates\[\]/);
  });
  it("returns empty string for no params", () => {
    expect(buildRawQuery({})).toBe("");
  });
});

describe("unwrapEnvelope", () => {
  const body = (result: unknown) => ({ response: { result } });
  it("unwraps a present array, even an empty one (empty is success, not error)", () => {
    expect(unwrapEnvelope(body({ taxes: [] }), "taxes", "array").value).toEqual([]);
    expect(unwrapEnvelope(body({ taxes: [1] }), "taxes", "array").value).toEqual([1]);
  });
  it("unwraps a present object, even an empty one", () => {
    expect(unwrapEnvelope(body({ balance_sheet: {} }), "balance_sheet", "object").value).toEqual({});
  });
  it("throws EnvelopeDriftError on a missing key", () => {
    expect(() => unwrapEnvelope(body({ other: [] }), "taxes", "array")).toThrow(EnvelopeDriftError);
  });
  it("throws EnvelopeDriftError on a wrong type", () => {
    expect(() => unwrapEnvelope(body({ taxes: "nope" }), "taxes", "array")).toThrow(EnvelopeDriftError);
    expect(() => unwrapEnvelope(body({ taxes: [1] }), "taxes", "object")).toThrow(EnvelopeDriftError);
  });
  it("throws EnvelopeDriftError on missing response/result/non-object bodies", () => {
    expect(() => unwrapEnvelope(null, "x", "array")).toThrow(EnvelopeDriftError);
    expect(() => unwrapEnvelope("html", "x", "array")).toThrow(EnvelopeDriftError);
    expect(() => unwrapEnvelope({}, "x", "array")).toThrow(EnvelopeDriftError);
    expect(() => unwrapEnvelope({ response: {} }, "x", "array")).toThrow(EnvelopeDriftError);
  });
});

describe("readPageMeta", () => {
  it("reads page meta; per_page optional", () => {
    expect(readPageMeta({ page: 1, pages: 2, total: 144, per_page: 100 })).toEqual({
      page: 1,
      pages: 2,
      total: 144,
      perPage: 100,
    });
    expect(readPageMeta({ page: 1, pages: 2, total: 144 })?.perPage).toBeNull();
  });
  it("returns null when meta is absent", () => {
    expect(readPageMeta({ taxes: [] })).toBeNull();
  });
});

describe("decodeReportParams", () => {
  const token = (payload: unknown) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  it("decodes the params claim", () => {
    expect(decodeReportParams(token({ params: { cash_based: true } }))).toEqual({ cash_based: true });
  });
  it("returns null for garbage, non-strings, and missing params", () => {
    expect(decodeReportParams("not-a-jwt")).toBeNull();
    expect(decodeReportParams(undefined)).toBeNull();
    expect(decodeReportParams(42)).toBeNull();
    expect(decodeReportParams(token({ other: 1 }))).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * rawRequest — the never-throw property
 * ------------------------------------------------------------------ */

describe("rawRequest never rejects", () => {
  it("call() throws a string", async () => {
    const r = await inProfile(((_m, _u, _c, _d, _n) => Promise.reject("boom")) as CallFn, () =>
      rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    expectFailure(r, "transport");
  });
  it("call() throws undefined", async () => {
    const r = await inProfile(((_m, _u, _c, _d, _n) => Promise.reject(undefined)) as CallFn, () =>
      rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    expectFailure(r, "transport");
  });
  it("call() resolves nullish", async () => {
    const r = await inProfile(((_m, _u, _c, _d, _n) => Promise.resolve(undefined)) as CallFn, () =>
      rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    expectFailure(r, "envelope_drift");
  });
  it("call() resolves with a null body", async () => {
    const r = await inProfile(
      ((_m, _u, _c, _d, _n) => Promise.resolve({ ok: true, data: null })) as CallFn,
      () => rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    expectFailure(r, "envelope_drift");
  });
  it("call() resolves HTML — body echoed, never discarded", async () => {
    const r = await inProfile(
      ((_m, _u, _c, _d, _n) => Promise.resolve({ ok: true, data: "<html>gateway</html>" })) as CallFn,
      () => rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    const f = expectFailure(r, "envelope_drift");
    expect(f.rawBody).toBe("<html>gateway</html>");
  });
  it("call() resolves 200-with-error-body (accounting namespace)", async () => {
    const body = { response: { errors: [{ message: "Invoice not found", errno: 1012, field: "invoiceid" }] } };
    const r = await inProfile(
      ((_m, _u, _c, _d, _n) => Promise.resolve({ ok: true, data: body })) as CallFn,
      () => rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    const f = expectFailure(r, "api_error");
    expect(f.message).toBe("Invoice not found");
    expect(f.statusCode).toBe("200");
  });
  it("call() resolves errors:[] — message still non-empty", async () => {
    const r = await inProfile(
      ((_m, _u, _c, _d, _n) => Promise.resolve({ ok: true, data: { response: { errors: [] } } })) as CallFn,
      () => rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    expectFailure(r, "api_error");
  });
  it("call() rejects with an SDK APIClientError shape", async () => {
    const err = Object.assign(new Error("The server could not verify your token"), {
      statusCode: "401",
      errors: [{ message: "unauthorized" }],
    });
    const r = await inProfile(((_m, _u, _c, _d, _n) => Promise.reject(err)) as CallFn, () =>
      rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    const f = expectFailure(r, "api_error");
    expect(f.statusCode).toBe("401");
  });
  it("a fake client with the wrong call arity is refused (contract gate)", async () => {
    const r = await inProfile(((_m: string) => Promise.resolve({})) as unknown as CallFn, () =>
      rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    const f = expectFailure(r, "transport");
    expect(f.message).toMatch(/contract changed/);
  });
  it("outside any profile context: failure, not a throw", async () => {
    const r = await rawRequest({ method: "GET", path: "/x", name: "T" });
    expectFailure(r, "transport");
  });
});

describe("rawRequest success path", () => {
  it("returns the parsed body and builds the URL from path+query", async () => {
    const urls: string[] = [];
    const body = { response: { result: { taxes: [{ name: "VAT" }] } } };
    const r = await inProfile(
      ((_m, url, _c, _d, _n) => {
        urls.push(url);
        return Promise.resolve({ ok: true, data: body });
      }) as CallFn,
      () => rawRequest({ method: "GET", path: "/acc/taxes/taxes", query: { page: 2 }, name: "T" }),
    );
    expect(r).toEqual({ ok: true, data: body });
    expect(urls).toEqual(["/acc/taxes/taxes?page=2"]);
  });
});

/* ------------------------------------------------------------------ *
 * rawList — exhaustive pagination, guards, budget stops
 * ------------------------------------------------------------------ */

const listOf = (n: number, tag = "row") => Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i}` }));
const list = (call: CallFn, opts: Partial<Parameters<typeof rawList>[0]> = {}) =>
  inProfile(call, () => rawList({ path: "/acc/things", envelopeKey: "things", name: "T", ...opts }));

describe("rawList", () => {
  it("REGRESSION (144 rows / 2 pages): exhausts every page, completeness computed", async () => {
    const r = (await list(pagedCall([listOf(100), listOf(44)]))) as Extract<RawListResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.rows).toHaveLength(144);
    expect(r.pages_fetched).toBe(2);
    expect(r.total).toBe(144);
  });
  it("empty collection is success (pages: 0 form)", async () => {
    const r = (await list(pagedCall([[]], { pagesTotal: 0, total: 0 }))) as Extract<RawListResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.rows).toEqual([]);
  });
  it("empty collection is success (pages: 1, empty page form)", async () => {
    const r = (await list(pagedCall([[]]))) as Extract<RawListResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.rows).toEqual([]);
  });
  it("page-echo mismatch → integrity failure, no partial data", async () => {
    const r = await list(pagedCall([listOf(100), listOf(44)], { echoPage: () => 1 }));
    const f = expectFailure(r, "integrity");
    expect(f).not.toHaveProperty("rows");
  });
  it("zero-progress page → integrity failure, fails fast", { timeout: 2000 }, async () => {
    const r = await list(pagedCall([listOf(100), []], { total: 144 }));
    expectFailure(r, "integrity");
  });
  it("mid-read failure → integrity failure (discards page 1), page-1 failure → underlying failure", async () => {
    let n = 0;
    const flaky: CallFn = async (m, u, c, d, name) => {
      n++;
      if (n === 2) throw Object.assign(new Error("boom"), { statusCode: "500" });
      return pagedCall([listOf(100), listOf(44)])(m, u, c, d, name);
    };
    expectFailure(await list(flaky), "integrity");
    const immediate: CallFn = (_m, _u, _c, _d, _n) =>
      Promise.reject(Object.assign(new Error("down"), { statusCode: "503" }));
    expectFailure(await list(immediate), "api_error");
  });
  it("row-count mismatch after a full read → integrity failure", async () => {
    const r = await list(pagedCall([listOf(100), listOf(43)], { total: 144 }));
    expectFailure(r, "integrity");
  });
  it("page cap → ok but incomplete, stopped_by page_cap", async () => {
    const r = (await list(pagedCall([listOf(100), listOf(100), listOf(100)]), {
      pageCap: 2,
    })) as Extract<RawListResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    if (!r.complete) expect(r.stopped_by).toBe("page_cap");
    expect(r.rows).toHaveLength(200);
  });
  it("time budget → ok but incomplete, stopped_by time_budget", async () => {
    const r = (await list(pagedCall([listOf(10), listOf(10), listOf(10)], { delayMs: 40 }), {
      budgetMs: 30,
    })) as Extract<RawListResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    if (!r.complete) expect(r.stopped_by).toBe("time_budget");
  });
  it("size ceiling → ok but incomplete, stopped_by size_ceiling", async () => {
    const r = (await list(pagedCall([listOf(100), listOf(100)]), {
      sizeCeilingBytes: 10,
    })) as Extract<RawListResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    if (!r.complete) expect(r.stopped_by).toBe("size_ceiling");
  });
  it("never exposes page/per_page to callers via query leakage", async () => {
    const urls: string[] = [];
    await list(pagedCall([listOf(1)], { urls }), { query: { "clientids[]": [7] } });
    expect(urls[0]).toContain("clientids%5B%5D=7");
    expect(urls[0]).toContain("page=1");
    expect(urls[0]).toContain("per_page=100");
  });
});

/* ------------------------------------------------------------------ *
 * ALS profile isolation
 * ------------------------------------------------------------------ */

describe("profile isolation", () => {
  it("same-client identity: each profile's rawRequest uses that profile's client", async () => {
    const calls = { a: 0, b: 0 };
    const profileA = makeProfile("a", ((_m, _u, _c, _d, _n) => {
      calls.a++;
      return Promise.resolve({ ok: true, data: { who: "a" } });
    }) as CallFn);
    const profileB = makeProfile("b", ((_m, _u, _c, _d, _n) => {
      calls.b++;
      return Promise.resolve({ ok: true, data: { who: "b" } });
    }) as CallFn);
    const ra = await runInProfile(profileA, () => rawRequest({ method: "GET", path: "/x", name: "T" }));
    const rb = await runInProfile(profileB, () => rawRequest({ method: "GET", path: "/x", name: "T" }));
    expect(ra).toEqual({ ok: true, data: { who: "a" } });
    expect(rb).toEqual({ ok: true, data: { who: "b" } });
    expect(calls).toEqual({ a: 1, b: 1 });
  });

  it("INTERLEAVED two-profile concurrency: pages never cross profiles", async () => {
    // Each profile's fake resolves only when released, letting us interleave
    // A1 → B1 → A2 → B2 across two concurrent rawList runs. ALS must keep each
    // loop bound to its own profile through every await.
    const gates: Record<string, Array<() => void>> = { a: [], b: [] };
    const mk = (tag: string): CallFn =>
      (async (_m: string, url: string, _c: object, _d: unknown, _n: string) => {
        await new Promise<void>((resolve) => gates[tag].push(resolve));
        const page = Number(new URL(`http://x${url}`).searchParams.get("page"));
        return {
          ok: true,
          data: {
            response: {
              result: {
                things: [{ owner: tag, page }],
                page,
                pages: 2,
                per_page: 100,
                total: 2,
              },
            },
          },
        };
      }) as CallFn;

    const pa = runInProfile(makeProfile("a", mk("a")), () =>
      rawList({ path: "/acc/things", envelopeKey: "things", name: "A" }),
    );
    const pb = runInProfile(makeProfile("b", mk("b")), () =>
      rawList({ path: "/acc/things", envelopeKey: "things", name: "B" }),
    );

    const release = async (tag: string) => {
      while (gates[tag].length === 0) await new Promise((r) => setTimeout(r, 1));
      gates[tag].shift()!();
      await new Promise((r) => setTimeout(r, 5)); // let the released page process
    };
    await release("a"); // A page 1
    await release("b"); // B page 1
    await release("a"); // A page 2
    await release("b"); // B page 2

    const [ra, rb] = (await Promise.all([pa, pb])) as [
      Extract<RawListResult, { ok: true }>,
      Extract<RawListResult, { ok: true }>,
    ];
    expect(ra.rows).toEqual([
      { owner: "a", page: 1 },
      { owner: "a", page: 2 },
    ]);
    expect(rb.rows).toEqual([
      { owner: "b", page: 1 },
      { owner: "b", page: 2 },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * renderRaw
 * ------------------------------------------------------------------ */

describe("renderRaw", () => {
  it("WARNING_INCOMPLETE is the FIRST key of an incomplete listing payload", async () => {
    const r = await list(pagedCall([listOf(2), listOf(2), listOf(2)]), { pageCap: 1 });
    const out = renderRaw(r);
    expect(out.isError).toBeUndefined();
    const parsed = JSON.parse(out.content[0].text);
    expect(Object.keys(parsed)[0]).toBe("WARNING_INCOMPLETE");
    expect(parsed.WARNING_INCOMPLETE).toMatch(/WRONG/);
    expect(parsed.stopped_by).toBe("page_cap");
  });
  it("a complete listing carries complete: true and no warning", async () => {
    const r = await list(pagedCall([listOf(3)]));
    const parsed = JSON.parse(renderRaw(r).content[0].text);
    expect(parsed.complete).toBe(true);
    expect(parsed).not.toHaveProperty("WARNING_INCOMPLETE");
  });
  it("403 → do-not-retry capability-gap imperative", () => {
    const out = renderRaw({ ok: false, kind: "api_error", statusCode: "403", message: "Forbidden" });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/Do not retry/);
    expect(out.content[0].text).toMatch(/capability gap/);
  });
  it("422 → do-not-guess-fields imperative", () => {
    const out = renderRaw({ ok: false, kind: "api_error", statusCode: "422", message: "Unprocessable" });
    expect(out.content[0].text).toMatch(/DO NOT guess/);
  });
  it("drift → echoes the raw payload", () => {
    const out = renderRaw({
      ok: false,
      kind: "envelope_drift",
      message: "Envelope drift: no key",
      rawBody: { odd: true },
    });
    expect(out.content[0].text).toContain('{"odd":true}');
    expect(out.content[0].text).toMatch(/report it as a bug/);
  });
  it("a throwing shape() becomes a failure result, never an escape (never-throw covers the renderer)", async () => {
    const r = await inProfile(
      ((_m, _u, _c, _d, _n) =>
        Promise.resolve({ ok: true, data: { response: { result: { wrong_key: {} } } } })) as CallFn,
      () => rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    const out = renderRaw(r, (data) => unwrapEnvelope(data, "balance_sheet", "object").value);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/Envelope drift/);
    const outPlain = renderRaw(r, () => {
      throw new Error("shape exploded");
    });
    expect(outPlain.isError).toBe(true);
    expect(outPlain.content[0].text).toMatch(/shape exploded/);
  });
  it("shape() maps success data", async () => {
    const r = await inProfile(
      ((_m, _u, _c, _d, _n) =>
        Promise.resolve({ ok: true, data: { response: { result: { taxes: [1, 2] } } } })) as CallFn,
      () => rawRequest({ method: "GET", path: "/x", name: "T" }),
    );
    const out = renderRaw(r, (data) => unwrapEnvelope(data, "taxes", "array").value);
    expect(JSON.parse(out.content[0].text)).toEqual([1, 2]);
  });
});
