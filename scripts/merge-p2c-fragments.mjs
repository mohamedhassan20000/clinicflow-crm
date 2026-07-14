#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const path = "messages/en.json";
const catalog = JSON.parse(readFileSync(path, "utf8"));
const namespaces = {};

function getDeep(root, path) {
  return path.split(".").reduce((value, part) => value?.[part], root);
}

function setDeep(root, path, value) {
  const parts = path.split(".");
  let cursor = root;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ??= {};
  cursor[parts.at(-1)] = value;
}

for (const file of readdirSync(".p2c-messages").filter((name) => name.endsWith(".json")).sort()) {
  const namespace = file.split(".", 1)[0];
  const messages = namespaces[namespace] ??= structuredClone(catalog[namespace] ?? {});
  for (const [key, value] of Object.entries(JSON.parse(readFileSync(`.p2c-messages/${file}`, "utf8")))) {
    const existing = getDeep(messages, key);
    if (existing !== undefined && existing !== value) {
      // The two source labels differ only in title casing. Keep the sentence-case product style.
      const normalizedExisting = String(existing).toLowerCase().replace(/[^a-z0-9]/g, "");
      const normalizedIncoming = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
      if (normalizedExisting === normalizedIncoming) {
        setDeep(
          messages,
          key,
          existing[0] + existing.slice(1).toLowerCase() === existing ? existing : value,
        );
      } else if (key === "saveChanges") setDeep(messages, key, "Save changes");
      else throw new Error(`Conflicting ${namespace} message ${key}: ${existing} / ${value}`);
    } else {
      setDeep(messages, key, value);
    }
  }
}

for (const [namespace, messages] of Object.entries(namespaces)) catalog[namespace] = messages;
catalog.shell = {
  ...(catalog.shell ?? {}),
  brand: "ClinicFlow",
  expandNavigation: "Expand navigation",
  collapseNavigation: "Collapse navigation",
  navigationLabel: "{brand} navigation",
  openNavigation: "Open navigation",
  openUserMenu: "Open user menu",
  myProfile: "My profile",
  preferences: "Preferences",
  signOut: "Sign out",
  navigationMenu: "Navigation menu"
};
catalog.nav = {
  tenant: {
    dashboard: "Dashboard",
    patients: "Patients",
    appointments: "Appointments",
    followups: "Follow-ups",
    revenue: "Revenue",
    reports: "Reports",
    settings: "Settings"
  },
  operator: {
    missionControl: "Mission control",
    clinics: "Clinics",
    invitations: "Invitations",
    reports: "Reports",
    coupons: "Coupons",
    settings: "Settings"
  }
};

writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
console.log("Merged extracted messages plus shell and navigation.");
