import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { connectedSession, waitFor } from "./harness.ts";

describe("linked-device contact persistence", () => {
  it("persists live contact updates for the Inbox picker", async () => {
    const harness = await connectedSession();
    try {
      harness.socket.emit("contacts.upsert", [{
        id: "201111111111@s.whatsapp.net",
        name: "Fatima Ahmed",
      }]);
      await waitFor(
        () => harness.store.contacts.get("+201111111111") === "Fatima Ahmed",
        "the contact to be persisted",
      );
    } finally {
      harness.restore();
    }
  });

  it("persists the bounded contacts snapshot carried by the initial history sync", async () => {
    const harness = await connectedSession();
    try {
      harness.socket.emit("messaging-history.set", {
        chats: [],
        messages: [],
        contacts: [{ id: "201222222222@s.whatsapp.net", name: "Mona" }],
        isLatest: true,
      });
      await waitFor(
        () => harness.store.contacts.get("+201222222222") === "Mona",
        "the history contact to be persisted",
      );
    } finally {
      harness.restore();
    }
  });

  it("uses the field names the database RPC validates", () => {
    const source = fs.readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
    const start = source.indexOf("async upsertContacts");
    const end = source.indexOf("async upsertLidMappings", start);
    const call = source.slice(start, end);
    assert.match(call, /participantAddress: contact\.participantAddress/);
    assert.match(call, /displayName: contact\.displayName/);
    assert.doesNotMatch(call, /participant_address|display_name/);
  });
});
