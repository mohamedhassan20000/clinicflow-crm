import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: async (key: string) => key,
}));

import { mutationFailure } from "@/actions/clinical/_shared";

describe("P7 Manual QA polish Phase 6 clinical failure logging", () => {
  it("returns the generic clinical message and logs the real database cause", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const databaseError = {
      code: "42P01",
      message: "relation drug_catalog does not exist",
    };

    const result = await mutationFailure("drug_catalog_insert_failed", {
      clinicId: "clinic-1",
      error: databaseError,
    });

    expect(result).toEqual({ error: "clinical.mutationFailed" });
    expect(errorSpy).toHaveBeenCalledWith(
      "drug_catalog_insert_failed",
      expect.objectContaining({
        clinicId: "clinic-1",
        error: databaseError,
        message: databaseError.message,
      }),
    );
    errorSpy.mockRestore();
  });
});
