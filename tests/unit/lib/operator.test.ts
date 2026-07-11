import { describe, expect, it } from "vitest";
import { couponExpiryFromInput, issuanceBlocked, manualGrantPeriod } from "@/lib/operator";
import { buildZip, csvRow } from "@/lib/zip";

const now = new Date("2026-07-10T12:00:00.000Z");

describe("invitation issuance quota (§3.2 — issuance-time only)", () => {
  it("blocks when accepted plus open invitations reach the weekly limit", () => {
    expect(issuanceBlocked({ acceptedThisWeek: 14, pendingIssued: 6, weeklyLimit: 20 })).toBe(true);
    expect(issuanceBlocked({ acceptedThisWeek: 14, pendingIssued: 5, weeklyLimit: 20 })).toBe(false);
    expect(issuanceBlocked({ acceptedThisWeek: 25, pendingIssued: 0, weeklyLimit: 20 })).toBe(true);
  });

  it("lets the operator explicitly override the block", () => {
    expect(issuanceBlocked({ acceptedThisWeek: 20, pendingIssued: 5, weeklyLimit: 20 }, true)).toBe(false);
  });
});

describe("manual grant periods", () => {
  it("grants an unbounded period when months is null", () => {
    expect(manualGrantPeriod(null, "2026-08-01T00:00:00.000Z", now)).toMatchObject({
      current_period_end: null,
    });
  });

  it("extends from a live period end and from now for lapsed ones", () => {
    expect(manualGrantPeriod(3, "2026-08-01T00:00:00.000Z", now).current_period_end).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(manualGrantPeriod(3, "2026-01-01T00:00:00.000Z", now).current_period_end).toBe(
      "2026-10-10T12:00:00.000Z",
    );
    expect(manualGrantPeriod(3, null, now).current_period_end).toBe("2026-10-10T12:00:00.000Z");
  });

  it("clamps month-end overflow like the coupon RPC", () => {
    const january31 = new Date("2026-01-31T00:00:00.000Z");
    expect(manualGrantPeriod(1, null, january31).current_period_end).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });
});

describe("store-only zip builder", () => {
  it("produces a structurally valid archive with intact payloads", () => {
    const zip = buildZip(
      [
        { name: "patients.csv", data: "id,name\n1,Test" },
        { name: "empty.csv", data: "" },
      ],
      now,
    );

    // Local header, central directory, and end-of-central-directory signatures.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const endOffset = zip.length - 22;
    expect(zip.readUInt32LE(endOffset)).toBe(0x06054b50);
    expect(zip.readUInt16LE(endOffset + 10)).toBe(2); // total entries

    const centralOffset = zip.readUInt32LE(endOffset + 16);
    expect(zip.readUInt32LE(centralOffset)).toBe(0x02014b50);

    // Stored payload is byte-for-byte recoverable at the recorded offset.
    const nameLength = zip.readUInt16LE(26);
    const payload = zip.subarray(30 + nameLength, 30 + nameLength + "id,name\n1,Test".length);
    expect(payload.toString("utf8")).toBe("id,name\n1,Test");
    expect(zip.subarray(30, 30 + nameLength).toString("utf8")).toBe("patients.csv");
  });

  it("escapes CSV cells containing quotes, commas, and newlines", () => {
    expect(csvRow(['He said "hi"', "a,b", "line\nbreak", null, 5])).toBe(
      '"He said ""hi""","a,b","line\nbreak",,5',
    );
  });

  it.each([
    ["=", '=HYPERLINK("https://evil.example")'],
    ["+", "+1+1"],
    ["-", "-2+3"],
    ["@", "@SUM(A1)"],
    ["\\t", "\tpayload"],
    ["\\r", "\rpayload"],
  ])("neutralizes formula-prefix %s cells with a quoted apostrophe", (_label, cell) => {
    const output = csvRow([cell]);
    expect(output.startsWith('"\'')).toBe(true); // quoted + apostrophe-prefixed
    expect(output).toBe(`"'${cell.replaceAll('"', '""')}"`);
  });

  it("leaves normal cells and numeric values untouched", () => {
    expect(csvRow(["Alice", "a1=b1", 5, -5, 0, "2026-07-11"])).toBe("Alice,a1=b1,5,-5,0,2026-07-11");
  });

  it("refuses archives that exceed the non-ZIP64 entry-count limit", () => {
    const entries = Array.from({ length: 0x10000 }, (_, index) => ({
      name: `f${index}`,
      data: "",
    }));
    expect(() => buildZip(entries, now)).toThrow(RangeError);
  });
});

describe("coupon expiry normalization", () => {
  it("treats a date-only expiry as inclusive through the end of that UTC day", () => {
    expect(couponExpiryFromInput("2026-08-01")).toBe("2026-08-01T23:59:59.999Z");
  });

  it("passes full ISO timestamps through unchanged", () => {
    expect(couponExpiryFromInput("2026-08-01T10:30:00.000Z")).toBe("2026-08-01T10:30:00.000Z");
  });
});
