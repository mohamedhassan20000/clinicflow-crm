import { describe, expect, it } from "vitest";
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_ENTITY_TYPES,
  activityActionMessageKey,
  activityActionTone,
} from "@/lib/activity/events";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";

describe("Phase 8D — activity event catalog", () => {
  it("derives camelCase message keys from dotted action ids", () => {
    expect(activityActionMessageKey("appointment.confirmed")).toBe("appointmentConfirmed");
    expect(activityActionMessageKey("follow_up.recorded")).toBe("followUpRecorded");
    expect(activityActionMessageKey("appointment.no_show")).toBe("appointmentNoShow");
  });

  it("assigns a known tone to every catalogued action", () => {
    for (const action of ACTIVITY_ACTIONS) {
      expect(["neutral", "positive", "warning", "negative"]).toContain(
        activityActionTone(action),
      );
    }
  });

  it("falls back to a neutral tone for unknown actions", () => {
    expect(activityActionTone("something.unexpected")).toBe("neutral");
  });

  it("covers exactly the appointment and follow-up entity types", () => {
    expect([...ACTIVITY_ENTITY_TYPES]).toEqual(["appointment", "follow_up"]);
  });

  it("has an English and Arabic label for every catalogued action", () => {
    const enActions = en.activity.actions as Record<string, string>;
    const arActions = ar.activity.actions as Record<string, string>;
    for (const action of ACTIVITY_ACTIONS) {
      const key = activityActionMessageKey(action);
      expect(enActions[key], `missing en label for ${action}`).toBeTruthy();
      expect(arActions[key], `missing ar label for ${action}`).toBeTruthy();
    }
  });

  it("has no orphan action labels beyond the catalog", () => {
    const catalogKeys = new Set(ACTIVITY_ACTIONS.map(activityActionMessageKey));
    for (const key of Object.keys(en.activity.actions)) {
      expect(catalogKeys.has(key), `orphan en label ${key}`).toBe(true);
    }
  });
});
