#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const path = "messages/ar.json";
const catalog = JSON.parse(readFileSync(path, "utf8"));
const reviewed = {
  settings: {
    daysLeft: "{days, plural, one {متبقٍ يوم واحد} other {متبقي # أيام}}",
  },
  appointments: {
    billingDescription: "أضف الخدمات المقدمة، ثم سجّل الدفعة.{patient}",
    patientNamedSuffix: " المريض: {patient}.",
    daysLeft: "{days, plural, one {متبقٍ يوم واحد} other {متبقي # أيام}}",
    currentTimeNamed: "الوقت الحالي: {time}",
  },
  dashboard: {
    queueAppointmentCount: "{count, plural, one {موعد واحد في قائمة الانتظار} other {# مواعيد في قائمة الانتظار}}",
  },
  operator: {
    clinicNamed: "العيادة: {clinic}",
    namedReport: "تقرير {name}",
    searchNamed: "ابحث في {label}…",
    sortByDirection: "ترتيب حسب {column}، {direction}",
    showingRangeOfTotal: "عرض {first}–{last} من أصل {total}",
  },
  patients: {
    searchResultsFor: "نتائج البحث عن «{search}»",
  },
  protected: {
    patientCountScope: "{count, plural, one {مريض واحد} other {# مرضى}} {scope}{department}{doctor}.",
    patientCount: "{count, plural, one {مريض واحد} other {# مرضى}}",
    departmentNamed: "القسم: {department}",
    doctorNamed: "الطبيب: {doctor}",
    doctorNamedSuffix: " · الطبيب: {doctor}",
    appointmentCountRange: "{count, plural, one {موعد واحد} other {# مواعيد}} {range}{filters}.",
  },
  shared: {
    backToNamed: "العودة إلى {label}",
  },
};

for (const [namespace, messages] of Object.entries(reviewed)) {
  Object.assign(catalog[namespace], messages);
}
writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
console.log("Applied context-reviewed Arabic ICU messages.");
