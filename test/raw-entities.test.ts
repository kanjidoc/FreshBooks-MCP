import { describe, it, expect } from "vitest";
import type { Client } from "@freshbooks/api";
import { runInProfile, type ProfileState } from "../src/profiles";
import {
  listEstimates,
  getEstimate,
  createEstimate,
  updateEstimate,
  deleteEstimate,
  sendEstimate,
} from "../src/tools/raw/estimates";
import { listStaff, getStaffMember } from "../src/tools/raw/staff";
import { listTaxes, getTax, createTax, updateTax, deleteTax } from "../src/tools/raw/taxes";
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

describe("raw write tools — wire bodies (T1, from the go/no-go transcripts)", () => {
  /** Capture method/url/body of each call, serve a canned single-item result. */
  const recording = (key: string, log: Array<{ method: string; url: string; body: unknown }>): CallFn =>
    (async (method: string, url: string, _c: object, body: unknown, _n: string) => {
      log.push({ method, url, body });
      return { ok: true, data: { response: { result: { [key]: { id: 42, status: 1 } } } } };
    }) as CallFn;

  it("create_tax POSTs { tax: {...} } to the verified path; number omitted when absent", async () => {
    const log: Array<{ method: string; url: string; body: unknown }> = [];
    await runInProfile(profileWith(recording("tax", log)), () =>
      createTax.handler({ name: "VAT", amount: "7.5" } as any, {}),
    );
    expect(log).toEqual([
      {
        method: "POST",
        url: "/accounting/account/ACC123/taxes/taxes",
        body: { tax: { name: "VAT", amount: "7.5" } },
      },
    ]);
  });

  it("update_tax PUTs only the provided fields (merge semantics — verified live)", async () => {
    const log: Array<{ method: string; url: string; body: unknown }> = [];
    await runInProfile(profileWith(recording("tax", log)), () =>
      updateTax.handler({ tax_id: 9, amount: "8" } as any, {}),
    );
    expect(log[0]).toEqual({
      method: "PUT",
      url: "/accounting/account/ACC123/taxes/taxes/9",
      body: { tax: { amount: "8" } },
    });
  });

  it("update_tax with nothing to update refuses without any API call", async () => {
    const log: Array<{ method: string; url: string; body: unknown }> = [];
    const res = await runInProfile(profileWith(recording("tax", log)), () =>
      updateTax.handler({ tax_id: 9 } as any, {}),
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(log).toHaveLength(0);
  });

  it("delete_tax uses the DELETE verb (hard delete — verified live)", async () => {
    const log: Array<{ method: string; url: string; body: unknown }> = [];
    await runInProfile(profileWith(recording("tax", log)), () => deleteTax.handler({ tax_id: 9 } as any, {}));
    expect(log[0].method).toBe("DELETE");
    expect(log[0].url).toBe("/accounting/account/ACC123/taxes/taxes/9");
  });

  it("create_estimate sends customerid (not clientid) + create_date + wire-shaped lines", async () => {
    const log: Array<{ method: string; url: string; body: unknown }> = [];
    await runInProfile(profileWith(recording("estimate", log)), () =>
      createEstimate.handler(
        {
          client_id: 77,
          create_date: "2026-07-29",
          lines: [{ name: "Consulting", qty: "2", unit_cost: "150.00", currency_code: "USD" }],
        } as any,
        {},
      ),
    );
    expect(log[0]).toEqual({
      method: "POST",
      url: "/accounting/account/ACC123/estimates/estimates",
      body: {
        estimate: {
          customerid: 77,
          create_date: "2026-07-29",
          lines: [{ name: "Consulting", qty: "2", unit_cost: { amount: "150.00", code: "USD" }, type: 0 }],
        },
      },
    });
  });

  it("update_estimate PUTs only provided fields; delete_estimate reports soft_delete", async () => {
    const log: Array<{ method: string; url: string; body: unknown }> = [];
    await runInProfile(profileWith(recording("estimate", log)), () =>
      updateEstimate.handler({ estimate_id: 5, notes: "n" } as any, {}),
    );
    expect(log[0].body).toEqual({ estimate: { notes: "n" } });
    const res = await runInProfile(profileWith(recording("estimate", log)), () =>
      deleteEstimate.handler({ estimate_id: 5 } as any, {}),
    );
    expect(JSON.parse(textOf(res as any)).soft_delete).toBe(true);
  });

  it("send_estimate REFUSES with no recipients — the fake call is NEVER invoked", async () => {
    const log: Array<{ method: string; url: string; body: unknown }> = [];
    for (const args of [{ estimate_id: 5 }, { estimate_id: 5, email_recipients: [] }]) {
      const res = await runInProfile(profileWith(recording("estimate", log)), () =>
        sendEstimate.handler(args as any, {}),
      );
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res as any)).toMatch(/Refusing to send/);
    }
    expect(log).toHaveLength(0); // the send path is unreachable without recipients
  });

  it("send_estimate PUTs action_email + the exact recipient list", async () => {
    const log: Array<{ method: string; url: string; body: unknown }> = [];
    await runInProfile(profileWith(recording("estimate", log)), () =>
      sendEstimate.handler({ estimate_id: 5, email_recipients: ["owner@example.com"] } as any, {}),
    );
    expect(log[0]).toEqual({
      method: "PUT",
      url: "/accounting/account/ACC123/estimates/estimates/5",
      body: { estimate: { action_email: true, email_recipients: ["owner@example.com"] } },
    });
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
