import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Quote } from "./types";

vi.mock("./yahoo", () => ({ yahoo: { name: "yahoo", quote: vi.fn(), fx: vi.fn() } }));
vi.mock("./coingecko", () => ({ coingecko: { name: "coingecko", quote: vi.fn(), fx: vi.fn() } }));

import { fetchQuotes, fetchFx } from "./index";
import { yahoo } from "./yahoo";
import { coingecko } from "./coingecko";

const q = (price_e8: number): Quote => ({ price_e8, currency: "USD", as_of: "2077-01-01" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(yahoo.quote).mockResolvedValue(null);
  vi.mocked(yahoo.fx).mockResolvedValue(null);
  vi.mocked(coingecko.quote).mockResolvedValue(null);
  vi.mocked(coingecko.fx).mockResolvedValue(null);
});

describe("fetchQuotes chain", () => {
  it("yahoo resolves stocks/ETFs; coingecko is not consulted", async () => {
    vi.mocked(yahoo.quote).mockResolvedValue(q(100));
    const out = await fetchQuotes([{ symbol: "VWRA.L", kind: "etf" }]);
    expect(out.get("VWRA.L")).toEqual({ ...q(100), source: "yahoo" });
    expect(coingecko.quote).not.toHaveBeenCalled();
  });

  it("a yahoo failure is an error entry naming yahoo; no fallback source is consulted", async () => {
    const out = await fetchQuotes([{ symbol: "AAPL", kind: "stock" }]);
    const entry = out.get("AAPL")!;
    expect("error" in entry).toBe(true);
    expect((entry as { error: string }).error).toContain("yahoo");
    expect((entry as { error: string }).error.toLowerCase()).not.toContain("stooq");
  });

  it("routes crypto to coingecko only", async () => {
    vi.mocked(coingecko.quote).mockResolvedValue(q(300));
    const out = await fetchQuotes([{ symbol: "BTC", kind: "crypto" }]);
    expect(out.get("BTC")).toEqual({ ...q(300), source: "coingecko" });
    expect(yahoo.quote).not.toHaveBeenCalled();
  });

  it("a crypto failure is an error entry naming coingecko", async () => {
    const out = await fetchQuotes([{ symbol: "BTC", kind: "crypto" }]);
    expect((out.get("BTC") as { error: string }).error).toContain("coingecko");
  });

  it("a throwing adapter is treated as a failed source, not a thrown chain", async () => {
    vi.mocked(yahoo.quote).mockRejectedValue(new Error("boom"));
    const out = await fetchQuotes([{ symbol: "AAPL", kind: "stock" }]);
    const entry = out.get("AAPL")!;
    expect("error" in entry).toBe(true);
    expect((entry as { error: string }).error).toContain("yahoo");
  });

  it("resolves a mixed batch per symbol", async () => {
    vi.mocked(yahoo.quote).mockImplementation(async (s: string) => (s === "VWRA.L" ? q(1) : null));
    vi.mocked(coingecko.quote).mockResolvedValue(q(2));
    const out = await fetchQuotes([
      { symbol: "VWRA.L", kind: "etf" },
      { symbol: "BTC", kind: "crypto" },
      { symbol: "DEAD", kind: "stock" },
    ]);
    expect(out.get("VWRA.L")).toEqual({ ...q(1), source: "yahoo" });
    expect(out.get("BTC")).toEqual({ ...q(2), source: "coingecko" });
    expect("error" in out.get("DEAD")!).toBe(true);
  });
});

describe("fetchFx chain", () => {
  it("yahoo resolves FX pairs", async () => {
    vi.mocked(yahoo.fx).mockResolvedValue(q(4));
    const out = await fetchFx(["USDMYR"]);
    expect(out.get("USDMYR")).toEqual({ ...q(4), source: "yahoo" });
  });

  it("a yahoo FX failure is an error entry naming yahoo", async () => {
    const out = await fetchFx(["USDMYR"]);
    const entry = out.get("USDMYR")!;
    expect("error" in entry).toBe(true);
    expect((entry as { error: string }).error).toContain("yahoo");
    expect((entry as { error: string }).error.toLowerCase()).not.toContain("stooq");
  });
});
