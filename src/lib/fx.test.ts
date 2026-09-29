import { describe, it, expect } from "vitest";
import {
  FX_IDENTITY_E8,
  crossRateE8,
  resolveFxRateE8,
  estimateCashSen,
  tradeCashPrefillSen,
  accountMyrSen,
  transferReceivedPrefillSen,
  type FxRateRow,
} from "@/lib/fx";

/**
 * Pure in-memory fixtures (no DB): real-looking pairs are fine here — the
 * suite-unique fictional-code convention binds global DB tables only.
 * Rates: SGDMYR 3.28, USDMYR 4.42 (both ×1e8).
 */
const SGDMYR: FxRateRow = { pair: "SGDMYR", rate_e8: 328_000_000, as_of: "2077-05-30" };
const USDMYR: FxRateRow = { pair: "USDMYR", rate_e8: 442_000_000, as_of: "2077-05-31" };
const RATES = [SGDMYR, USDMYR];

describe("crossRateE8", () => {
  it("derives SGDUSD from the SGDMYR/USDMYR legs exactly (hand-checked)", () => {
    // SGDUSD = 3.28 / 4.42 = 328/442 = 0.742081447963800905… → ×1e8 =
    // 74,208,144.796… → half-up 74_208_145.
    // BigInt check: n = 328e6 × 1e8 = 3.28e16; 74,208,144 × 442e6 =
    // 3.2799999648e16 → remainder 352e6 ≥ d/2 = 221e6 → round up.
    expect(crossRateE8(328_000_000, 442_000_000)).toBe(74_208_145);
    // USDSGD = 4.42 / 3.28 = 1.347560975609… → ×1e8 = 134,756,097.56… →
    // half-up 134_756_098 (remainder 184e6 ≥ 164e6).
    expect(crossRateE8(442_000_000, 328_000_000)).toBe(134_756_098);
  });

  it("is exactly the identity for equal legs", () => {
    expect(crossRateE8(442_000_000, 442_000_000)).toBe(FX_IDENTITY_E8);
  });

  it("rounds half-up at the e8 boundary", () => {
    // 2.50000001 / 2.00 = 1.250000005 → ×1e8 = 125,000,000.5 → 125_000_001.
    expect(crossRateE8(250_000_001, 200_000_000)).toBe(125_000_001);
    // Exact division stays exact: 2.5 / 2.0 → 125_000_000.
    expect(crossRateE8(250_000_000, 200_000_000)).toBe(125_000_000);
  });

  it("stays exact on an overflow-sized intermediate (BigInt territory)", () => {
    // a = MAX_SAFE_INTEGER: a × 1e8 ≈ 9.007e23 — far beyond 2^53, float math
    // would drift here. Exact: 9007199254740991 / 3 = 3_002_399_751_580_330
    // remainder 1 → +1/3 < 0.5 → rounds down.
    expect(crossRateE8(9_007_199_254_740_991, 300_000_000)).toBe(3_002_399_751_580_330);
  });

  it("throws (assertSen guard) when the result exceeds the safe-integer exit", () => {
    // 9007199254740991 × 1e8 / 100 ≈ 9.007e21 — no silent unsafe number.
    expect(() => crossRateE8(9_007_199_254_740_991, 100)).toThrow(/invalid sen amount/);
  });
});

describe("resolveFxRateE8 — resolution order", () => {
  it("identity first: same currency needs no rate row", () => {
    expect(resolveFxRateE8("USD", "USD", RATES)).toEqual({
      fx_e8: FX_IDENTITY_E8,
      as_of: null,
      via: "identity",
    });
    expect(resolveFxRateE8("MYR", "MYR", [])).toEqual({
      fx_e8: FX_IDENTITY_E8,
      as_of: null,
      via: "identity",
    });
  });

  it("direct pair second: <CUR>MYR rows resolve directly", () => {
    expect(resolveFxRateE8("USD", "MYR", RATES)).toEqual({
      fx_e8: 442_000_000,
      as_of: "2077-05-31",
      via: "direct",
    });
  });

  it("a direct pair beats the via-MYR cross", () => {
    const withDirect = [...RATES, { pair: "SGDUSD", rate_e8: 74_000_000, as_of: "2077-05-29" }];
    expect(resolveFxRateE8("SGD", "USD", withDirect)).toEqual({
      fx_e8: 74_000_000,
      as_of: "2077-05-29",
      via: "direct",
    });
  });

  it("crosses via MYR from the two <CUR>MYR legs, dating by the OLDER leg (stale-conservative)", () => {
    expect(resolveFxRateE8("SGD", "USD", RATES)).toEqual({
      fx_e8: 74_208_145, // hand-checked above
      as_of: "2077-05-30", // SGD leg is older than the USD leg
      via: "cross",
    });
  });

  it("treats a MYR side of the cross as the identity leg", () => {
    // MYR→USD = 1 / 4.42 = 0.226244343891… → ×1e8 = 22,624,434.389… →
    // 22_624_434 (remainder 172e6 < 221e6 → down). Dated by the USD leg.
    expect(resolveFxRateE8("MYR", "USD", RATES)).toEqual({
      fx_e8: 22_624_434,
      as_of: "2077-05-31",
      via: "cross",
    });
  });

  it("returns null when no chain resolves — no prefill, never a guess", () => {
    expect(resolveFxRateE8("SGD", "JPY", RATES)).toBeNull();
    expect(resolveFxRateE8("SGD", "USD", [SGDMYR])).toBeNull();
    expect(resolveFxRateE8("SGD", "USD", [])).toBeNull();
  });
});

describe("estimateCashSen — ruling 6 fee signs", () => {
  it("buy settles gross + fees at the rate", () => {
    // (226,395 + 500)c × 4.42 = 226,895 × 4.42 = 1,002,875.9 → 1_002_876 sen.
    expect(estimateCashSen("buy", 226_395, 500, 442_000_000)).toBe(1_002_876);
  });

  it("sell proceeds are gross − fees at the rate", () => {
    // (226,395 − 500)c × 4.42 = 225,895 × 4.42 = 998,455.9 → 998_456 sen.
    expect(estimateCashSen("sell", 226_395, 500, 442_000_000)).toBe(998_456);
  });

  it("matches the portfolio worked example at zero fees", () => {
    // VWRA gross USD 2,263.95 × 4.42 = RM 10,006.659 → 1_000_666 sen
    // (src/lib/portfolio.ts header example).
    expect(estimateCashSen("buy", 226_395, 0, 442_000_000)).toBe(1_000_666);
  });

  it("identity rate keeps the same-currency arithmetic unchanged", () => {
    expect(estimateCashSen("buy", 5_000, 100, FX_IDENTITY_E8)).toBe(5_100);
    expect(estimateCashSen("sell", 5_000, 100, FX_IDENTITY_E8)).toBe(4_900);
  });
});

describe("tradeCashPrefillSen — the single prefill gate", () => {
  const base = {
    mode: "create" as const,
    cashDirty: false,
    side: "buy" as const,
    gross_cent: 226_395,
    fees_cent: 500,
    fx_e8: 442_000_000 as number | null,
  };

  it("prefills the estimate in create mode with a clean field and a rate", () => {
    expect(tradeCashPrefillSen(base)).toBe(1_002_876);
  });

  it("REGRESSION (Session-9 T7): edit mode NEVER re-prefills over a saved cash_delta_sen", () => {
    // The Plan-5 bug: edit-mode prefill silently overwrote the broker's
    // saved figure. Pinned here: edit mode always leaves the field alone.
    expect(tradeCashPrefillSen({ ...base, mode: "edit" })).toBeNull();
    expect(tradeCashPrefillSen({ ...base, mode: "edit", cashDirty: true })).toBeNull();
  });

  it("a user-touched field (cashDirty) is theirs — no re-prefill", () => {
    expect(tradeCashPrefillSen({ ...base, cashDirty: true })).toBeNull();
  });

  it("no resolvable rate → no prefill", () => {
    expect(tradeCashPrefillSen({ ...base, fx_e8: null })).toBeNull();
  });

  it("clamps a fees-exceed-gross sell at zero (cash_delta_sen is non-negative)", () => {
    expect(
      tradeCashPrefillSen({
        ...base,
        side: "sell",
        gross_cent: 100,
        fees_cent: 300,
        fx_e8: FX_IDENTITY_E8,
      }),
    ).toBe(0);
  });
});

describe("accountMyrSen — Task 5 account-balance conversion", () => {
  const rates = new Map([
    ["USDMYR", 442_000_000],
    ["SGDMYR", 328_000_000],
  ]);

  it("MYR is the identity — no rate row consulted", () => {
    expect(accountMyrSen(12_345, "MYR", new Map())).toBe(12_345);
  });

  it("converts a non-MYR balance via centToSen at the <CUR>MYR rate", () => {
    // USD 100.00 × 4.42 = RM 442.00 → 44_200 sen.
    expect(accountMyrSen(10_000, "USD", rates)).toBe(44_200);
  });

  it("rounds half-up at minor-unit precision", () => {
    // 1 cent × 4.42355555 = 4.42355555 sen → 4.
    expect(accountMyrSen(1, "USD", new Map([["USDMYR", 442_355_555]]))).toBe(4);
    // 1 cent × 4.5 = 4.5 sen → 5 (half-up).
    expect(accountMyrSen(1, "USD", new Map([["USDMYR", 450_000_000]]))).toBe(5);
  });

  it("keeps the sign of a negative balance", () => {
    expect(accountMyrSen(-10_000, "USD", rates)).toBe(-44_200);
  });

  it("null for a never-fetched rate (honest gap — never a fabricated rate)", () => {
    expect(accountMyrSen(10_000, "ZZX", rates)).toBeNull();
  });
});

describe("transferReceivedPrefillSen — cross-currency transfer estimate gate", () => {
  // MYR → USD at 4.42: the MYR→USD rate is the via-MYR cross
  // crossRateE8(identity, 442e6) = 22_624_434 (0.22624434 ×1e8).
  const MYR_TO_USD_E8 = crossRateE8(FX_IDENTITY_E8, 442_000_000);
  const base = {
    mode: "create" as const,
    receivedDirty: false,
    amount_sen: 10_000, // RM 100.00 leaving the source account
    fx_e8: MYR_TO_USD_E8,
  };

  it("create + clean field + resolvable rate → the converted estimate", () => {
    // 10_000 sen × 0.22624434 = 2_262.4434 cents → half-up 2_262 (USD 22.62).
    expect(transferReceivedPrefillSen(base)).toBe(2_262);
  });

  it("edit mode NEVER re-prefills over the saved received amount", () => {
    expect(transferReceivedPrefillSen({ ...base, mode: "edit" })).toBeNull();
    expect(transferReceivedPrefillSen({ ...base, mode: "edit", receivedDirty: true })).toBeNull();
  });

  it("a user-touched field is theirs — no re-prefill", () => {
    expect(transferReceivedPrefillSen({ ...base, receivedDirty: true })).toBeNull();
  });

  it("no resolvable rate → no prefill, never a guess", () => {
    expect(transferReceivedPrefillSen({ ...base, fx_e8: null })).toBeNull();
  });
});
