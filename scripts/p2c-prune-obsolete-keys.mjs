#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const obsolete = {
  dashboard: ["thisWeek2", "thisMonth2", "loadingQueue", "startSession"],
  operator: [
    "planUnavailable", "noRows", "noRowsMatchTheseFilters", "noReportDataYet",
    "clearTheActiveFiltersToReturn", "dataAppearsHereWhenThePlatform",
    "pointerEventsNoneOpacity50", "pointereventsnoneopacity50", "ascending",
  ],
  protected: [
    "thisDay", "thisMonth", "thisWeek", "inYourDepartment", "inYourClinic",
    "allPatients", "inyourdepartment", "matchingFilters",
  ],
  shared: ["backTo"],
};

for (const file of readdirSync(".p2c-messages").filter((name) => name.endsWith(".json"))) {
  const namespace = file.split(".", 1)[0];
  if (!obsolete[namespace]) continue;
  const path = `.p2c-messages/${file}`;
  const fragment = JSON.parse(readFileSync(path, "utf8"));
  let changed = false;
  for (const key of obsolete[namespace]) changed = delete fragment[key] || changed;
  if (changed) writeFileSync(path, `${JSON.stringify(fragment, null, 2)}\n`);
}

for (const path of ["messages/en.json", "messages/ar.json"]) {
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  for (const [namespace, keys] of Object.entries(obsolete)) {
    for (const key of keys) delete catalog[namespace]?.[key];
  }
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
}
console.log("Pruned obsolete provisional extraction keys.");
