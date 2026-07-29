import { describe, it, expect } from "vitest";
import type { Client } from "@freshbooks/api";
import { runInProfile, type ProfileState } from "../src/profiles";
import { listEstimates, getEstimate } from "../src/tools/raw/estimates";
import { listStaff, getStaffMember } from "../src/tools/raw/staff";
import { listTaxes, getTax } from "../src/tools/raw/taxes";
import { listInvoiceProfiles } from "../src/tools/raw/invoice-profiles";

type CallFn = (method: string, url: string, config: object, data: unknown, name: string) => any;

function profileWith(call: CallFn): ProfileState {
  return {
    name: "test",
    filePath: "/nonexistent/test.env",
    config: { accessToken: "a", refreshToken: "r", accountId: "ACC123", businessId: "" },
    client: { call } as unknown as Client,
    refreshInFlight: null,
  };
}

/** Serve one collection page under `key`, capturing URLs. */
const collection = (key: string, rows: unknown[], urls: string[]): CallFn =>
  (async (_m: string, url: string, _c: object, _d: unknown, _n: string) => {
    urls.push(url);
    return {
      ok: true,
      data: { response: { result: { [key]: rows, page: 1, pages: 1, per_page: 100, total: rows.length } } },
    };
  }) as CallFn;

/** Serve a single item under `key`, capturing URLs. */
const single = (key: string, item: unknown, urls: string[]): CallFn =>
  (async (_m: string, url: string, _c: object, _d: unknown, _n: string) => {
    urls.push(url);
    return { ok: true, data: { response: { result: { [key]: item } } } };
  }) as CallFn;

const textOf = (res: { content: Array<{ type: string }> }): string => {
  const c = res.content[0] as { text?: string };
  if (typeof c.text !== "string") throw new Error("no text content");
  return c.text;
};

describe("raw entity tools — wire paths (T1)", () => {
  const cases: Array<[string, { handler: (a: any, e: any) => Promise<any> }, string, unknown[]]> = [
    ["estimates", listEstimates, "/accounting/account/ACC123/estimates/estimates?page=1&per_page=100", []],
    ["staff", listStaff, "/accounting/account/ACC123/users/staffs?page=1&per_page=100", []],
    ["taxes", listTaxes, "/accounting/account/ACC123/taxes/taxes?page=1&per_page=100", []],
    [
      "invoice_profiles",
      listInvoiceProfiles,
      "/accounting/account/ACC123/invoice_profiles/invoice_profiles?page=1&per_page=100",
      [],
    ],
  ];
  for (const [key, tool, expectedUrl] of cases) {
    it(`list ${key} hits the verified path and exhausts`, async () => {
      const urls: string[] = [];
      const res = await runInProfile(profileWith(collection(key, [{ id: 1 }], urls)), () =>
        tool.handler({}, {}),
      );
      expect((res as { isError?: boolean }).isError).toBeUndefined();
      expect(urls).toEqual([expectedUrl]);
      const parsed = JSON.parse(textOf(res as any));
      expect(parsed.complete).toBe(true);
      expect(parsed.rows).toEqual([{ id: 1 }]);
    });
  }

  it("get tools hit the verified single-item paths with the id interpolated", async () => {
    const urls: string[] = [];
    await runInProfile(profileWith(single("estimate", { id: 7 }, urls)), () =>
      getEstimate.handler({ estimate_id: 7 } as any, {}),
    );
    await runInProfile(profileWith(single("staff", { id: 8 }, urls)), () =>
      getStaffMember.handler({ staff_id: 8 } as any, {}),
    );
    await runInProfile(profileWith(single("tax", { id: 9 }, urls)), () =>
      getTax.handler({ tax_id: 9 } as any, {}),
    );
    expect(urls).toEqual([
      // include[]=lines: without it the API omits line items (verified live)
      "/accounting/account/ACC123/estimates/estimates/7?include%5B%5D=lines",
      "/accounting/account/ACC123/users/staffs/8",
      "/accounting/account/ACC123/taxes/taxes/9",
    ]);
  });
});

describe("staff api_token stripping (SECURITY — a live credential was observed in this field)", () => {
  it("list_staff strips api_token from every row", async () => {
    const rows = [
      { id: 1, email: "a@b.c", api_token: "5ff14ecc80c1dd20360e39e537271880" },
      { id: 2, email: "d@e.f", api_token: null },
    ];
    const res = await runInProfile(profileWith(collection("staff", rows, [])), () =>
      listStaff.handler({}, {}),
    );
    const text = textOf(res as any);
    expect(text).not.toContain("api_token");
    expect(text).not.toContain("5ff14ecc80c1dd20360e39e537271880");
    const parsed = JSON.parse(text);
    expect(parsed.rows).toEqual([
      { id: 1, email: "a@b.c" },
      { id: 2, email: "d@e.f" },
    ]);
  });
  it("get_staff_member strips api_token", async () => {
    const res = await runInProfile(
      profileWith(single("staff", { id: 1, api_token: "secret-token-value" }, [])),
      () => getStaffMember.handler({ staff_id: 1 } as any, {}),
    );
    const text = textOf(res as any);
    expect(text).not.toContain("secret-token-value");
    expect(JSON.parse(text)).toEqual({ id: 1 });
  });
});

describe("raw entity error semantics", () => {
  it("an empty collection is success with zero rows, never an error", async () => {
    const res = await runInProfile(profileWith(collection("estimates", [], [])), () =>
      listEstimates.handler({}, {}),
    );
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(JSON.parse(textOf(res as any)).rows).toEqual([]);
  });
  it("a bogus id (404 throw from call) renders isError with the 404 preserved, never a throw", async () => {
    const notFound: CallFn = (_m, _u, _c, _d, _n) =>
      Promise.reject(Object.assign(new Error("Not Found"), { statusCode: "404" }));
    const res = await runInProfile(profileWith(notFound), () => getTax.handler({ tax_id: 999999999 } as any, {}));
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as any)).toContain("Not Found");
  });
  it("a drifted single-item envelope fails loudly with the body echoed", async () => {
    const res = await runInProfile(profileWith(single("wrong_key", { id: 1 }, [])), () =>
      getEstimate.handler({ estimate_id: 1 } as any, {}),
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as any)).toMatch(/Envelope drift/);
    expect(textOf(res as any)).toContain("wrong_key");
  });
});
