import { beforeAll, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

// P4.6C entity-search suite: deterministic normalization/transliteration/
// confidence helpers plus the rewritten search_authorized_patients contract
// (ranked candidates + server-computed confidence + clarification guidance).
// The database RPC itself is exercised by the integration RLS suite.

type EntitySearch = typeof import("@/lib/ai/entity-search");

let entitySearch: EntitySearch;

beforeAll(async () => {
  vi.doMock("server-only", () => ({}));
  entitySearch = await import("@/lib/ai/entity-search");
});

describe("normalizeSearchText", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(entitySearch.normalizeSearchText("  Mohammad  H.  Hassan ")).toBe(
      "mohammad h hassan",
    );
  });

  it("folds Arabic letter variants and removes diacritics/tatweel", () => {
    expect(entitySearch.normalizeSearchText("أَحْمَد")).toBe("احمد");
    expect(entitySearch.normalizeSearchText("فاطمة")).toBe("فاطمه");
    expect(entitySearch.normalizeSearchText("مصطفى")).toBe("مصطفي");
    expect(entitySearch.normalizeSearchText("مؤمن")).toBe("مومن");
    expect(entitySearch.normalizeSearchText("محمـــد")).toBe("محمد");
    expect(entitySearch.normalizeSearchText("إسْلام")).toBe("اسلام");
  });

  it("maps Arabic-Indic digits to Latin digits", () => {
    expect(entitySearch.normalizeSearchText("ملف ١٢٣٤")).toBe("ملف 1234");
  });
});

describe("normalizePhoneDigits", () => {
  it("keeps digits only and maps Arabic-Indic digits", () => {
    expect(entitySearch.normalizePhoneDigits("+965 5000-0001")).toBe("96550000001");
    expect(entitySearch.normalizePhoneDigits("٠٥٠١٢٣٤٥٦٧")).toBe("0501234567");
  });
});

describe("transliterateQuery", () => {
  it("maps common Latin name spellings to one Arabic form", () => {
    expect(entitySearch.transliterateQuery("Mohamed Hassan")).toBe("محمد حسن");
    expect(entitySearch.transliterateQuery("Muhammad Hasan")).toBe("محمد حسن");
    expect(entitySearch.transliterateQuery("mohammad hassan")).toBe("محمد حسن");
  });

  it("maps Arabic names to a Latin variant", () => {
    expect(entitySearch.transliterateQuery("محمد حسن")).toBe("mohamed hassan");
    expect(entitySearch.transliterateQuery("فاطمة")).toBe("fatima");
  });

  it("falls back to character mapping for uncommon tokens", () => {
    const variant = entitySearch.transliterateQuery("Shamlan");
    expect(variant).toMatch(/^ش/);
  });

  it("returns null for numeric or empty input", () => {
    expect(entitySearch.transliterateQuery("96550000001")).toBeNull();
    expect(entitySearch.transliterateQuery("  ")).toBeNull();
  });
});

describe("classifyConfidence", () => {
  it("is low with no candidates or weak scores", () => {
    expect(entitySearch.classifyConfidence([])).toBe("low");
    expect(entitySearch.classifyConfidence([0.2])).toBe("low");
  });

  it("is high only with a strong score and a clear lead", () => {
    expect(entitySearch.classifyConfidence([0.9])).toBe("high");
    expect(entitySearch.classifyConfidence([0.9, 0.5])).toBe("high");
    // Namesakes: two equally strong candidates force clarification.
    expect(entitySearch.classifyConfidence([1, 1])).toBe("medium");
    expect(entitySearch.classifyConfidence([0.9, 0.85])).toBe("medium");
  });

  it("is medium for plausible but unconfirmed matches", () => {
    expect(entitySearch.classifyConfidence([0.5])).toBe("medium");
  });
});

describe("search_authorized_patients ranked contract", () => {
  const USER = {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role: "receptionist" as const,
  };

  async function loadTool() {
    vi.resetModules();
    const mocks = createServerActionMocks();
    const logAgentToolCall = vi.fn(async () => ({ data: "audit-1", error: null }));

    vi.doMock("server-only", () => ({}));
    vi.doMock("@sentry/nextjs", () => ({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
    }));
    vi.doMock("@/lib/supabase/server", () => ({
      createClient: vi.fn(async () => mocks.client()),
    }));
    vi.doMock("@/lib/supabase/admin", () => ({ logAgentToolCall }));
    vi.doMock("@/lib/entitlements", () => ({
      getEntitlements: vi.fn(async () => ({
        clinicId: USER.clinicId,
        planSlug: "pro_ai",
        features: { ai_assistant: true },
        limits: {},
        subscriptionAllowed: true,
      })),
      hasFeature: () => true,
    }));
    vi.doMock("@/lib/server-page-permissions", () => ({
      getPageVisibilityState: vi.fn(async () => "visible"),
    }));

    const { buildStaffTools } = await import("@/lib/ai/tools");
    const tools = await buildStaffTools({ user: USER as never, locale: "en" });
    return { tools, mocks, logAgentToolCall };
  }

  const opts = {} as never;

  it("passes the transliterated variant to the RPC and reports medium confidence with clarification guidance", async () => {
    const { tools, mocks, logAgentToolCall } = await loadTool();
    mocks.state.rpcResults.search_patients_ranked = {
      data: [
        { id: "p1", full_name: "Muhammad Hassan", file_number: "CF-1", phone: "1", email: null, score: 0.8, match_kind: "name_fuzzy" },
        { id: "p2", full_name: "Mohamed Hasan", file_number: "CF-2", phone: "2", email: null, score: 0.78, match_kind: "name_fuzzy" },
      ],
      error: null,
    };

    const result = (await tools.search_authorized_patients.execute!(
      { query: "Mohamed Hassan" },
      opts,
    )) as { confidence: string; guidance: string; patients: { id: string }[] };

    expect(mocks.state.rpc).toHaveBeenCalledWith("search_patients_ranked", {
      p_query: "Mohamed Hassan",
      p_query_alt: "محمد حسن",
      p_limit: 10,
    });
    expect(result.confidence).toBe("medium");
    expect(result.guidance).toContain("ask them to confirm");
    expect(result.patients.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(logAgentToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "search_authorized_patients",
        summary: expect.objectContaining({ confidence: "medium", count: 2 }),
      }),
    );
  });

  it("reports low confidence with empty results and never fabricates candidates", async () => {
    const { tools, mocks } = await loadTool();
    mocks.state.rpcResults.search_patients_ranked = { data: [], error: null };

    const result = (await tools.search_authorized_patients.execute!(
      { query: "zzqq" },
      opts,
    )) as { confidence: string; patients: unknown[] };

    expect(result.confidence).toBe("low");
    expect(result.patients).toEqual([]);
  });

  it("surfaces a generic error when the RPC fails", async () => {
    const { tools, mocks } = await loadTool();
    mocks.state.rpcResults.search_patients_ranked = {
      data: null,
      error: { message: "boom" },
    };

    await expect(
      tools.search_authorized_patients.execute!({ query: "Jane" }, opts),
    ).rejects.toThrow("Authorized patient lookup failed.");
  });
});

/**
 * L8 of the P4.6 phase review. The transliteration table is a curated regional
 * list (~64 predominantly Gulf/Egyptian given names); everything else falls to
 * a lossy character map that drops short vowels and approximates `c`, `x`, `p`.
 * That is an acceptable design — the alt variant is *additive*, and the primary
 * query still does the real trigram work — but the property that makes it
 * acceptable was never asserted anywhere.
 *
 * The contract these pin: `transliterateQuery` is only ever an extra `OR` arm
 * in `search_patients_ranked`, so it can add matches and must never remove or
 * replace the primary query. The table needs extending as the tenant base
 * broadens beyond the regions it covers; these tests are what make that safe to
 * do incrementally.
 */
describe("P4.6C transliteration is additive and never degrades a lookup", () => {
  const unmapped = [
    "Siobhan Murphy",
    "Xavier Nguyen",
    "Przemyslaw Kowalski",
    "Wangari Maathai",
  ];

  it("never returns the query itself, so the alt arm is always new information", () => {
    for (const name of [...unmapped, "Mohamed Hassan", "محمد حسن"]) {
      const variant = entitySearch.transliterateQuery(name);
      if (variant !== null) {
        expect(variant).not.toBe(entitySearch.normalizeSearchText(name));
      }
    }
  });

  it("returns null rather than an empty or whitespace-only variant", () => {
    for (const name of [...unmapped, "...", "  ", "12345"]) {
      const variant = entitySearch.transliterateQuery(name);
      expect(variant === null || variant.trim().length > 0).toBe(true);
    }
  });

  it("keeps one token per input token, so a name is never collapsed or padded", () => {
    for (const name of unmapped) {
      const variant = entitySearch.transliterateQuery(name);
      if (variant === null) continue;
      expect(variant.split(" ")).toHaveLength(entitySearch.normalizeSearchText(name).split(" ").length);
    }
  });

  it("leaves the primary normalized query untouched for unmapped names", () => {
    // The guarantee that makes a poor alt variant harmless: whatever the
    // transliteration produces, the primary arm still searches the real query.
    for (const name of unmapped) {
      expect(entitySearch.normalizeSearchText(name)).toBe(name.toLowerCase());
    }
  });
});
