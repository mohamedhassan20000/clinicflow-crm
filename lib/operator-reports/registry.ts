import "server-only";
import { requirePlatformAdmin } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { listOperatorClinicMetadata, listOperatorUserCounts } from "@/lib/supabase/admin";
import { exportReportCsv, type OperatorReportDefinition, type ReportRow } from "./types";
function definition(input:Omit<OperatorReportDefinition,"export">):OperatorReportDefinition{const report={...input,export:(rows:ReportRow[])=>exportReportCsv(report,rows)};return report}
async function platform(table:"clinic_invitations"|"subscriptions"|"platform_audit_logs",columns:string){await requirePlatformAdmin();const db=await createClient();const result=await db.from(table).select(columns).limit(1000);if(result.error)throw new Error(`Unable to load ${table} report.`);return(result.data??[])as unknown as ReportRow[]}
async function clinics(){await requirePlatformAdmin();const r=await listOperatorClinicMetadata();if(r.error)throw new Error("Unable to load clinics report.");return(r.data??[])as unknown as ReportRow[]}
async function users(){await requirePlatformAdmin();const r=await listOperatorUserCounts();if(r.error)throw new Error("Unable to load users report.");return(r.data??[])as ReportRow[]}
async function revenue(){const rows=await platform("subscriptions","status, provider, current_period_end, plans(name_en, monthly_price_usd)");return rows.map(r=>{const p=r.plans as unknown as {name_en:string;monthly_price_usd:number}|null;return{status:r.status,provider:r.provider,plan:p?.name_en??null,monthly_price_usd:p?.monthly_price_usd??0,current_period_end:r.current_period_end}})}
async function growth(){const rows=await clinics();const counts=new Map<string,number>();for(const row of rows){const month=String(row.created_at).slice(0,7);counts.set(month,(counts.get(month)??0)+1)}return[...counts].sort(([a],[b])=>a.localeCompare(b)).map(([month,new_clinics])=>({month,new_clinics}))}
const reports:OperatorReportDefinition[]=[
 definition({id:"clinics",title:"Clinics",description:"Tenant metadata and onboarding state.",columns:[{key:"name",label:"Clinic"},{key:"country",label:"Country"},{key:"created_at",label:"Created"}],query:clinics}),
 definition({id:"users",title:"Users",description:"Platform-safe user totals by clinic; no personal fields.",columns:[{key:"clinic_name",label:"Clinic"},{key:"user_count",label:"Users"},{key:"latest_signup",label:"Latest signup"}],query:users}),
 definition({id:"invitations",title:"Invitations",description:"Invitation lifecycle and email delivery state.",columns:[{key:"clinic_name",label:"Clinic"},{key:"status",label:"Status"},{key:"created_at",label:"Created"},{key:"email_sent_at",label:"Email sent"}],query:()=>platform("clinic_invitations","clinic_name, status, created_at, email_sent_at")}),
 definition({id:"revenue",title:"Revenue",description:"Canonical USD recurring plan revenue.",columns:[{key:"plan",label:"Plan"},{key:"monthly_price_usd",label:"Monthly USD"},{key:"status",label:"Status"},{key:"current_period_end",label:"Period end"}],query:revenue}),
 definition({id:"subscriptions",title:"Subscriptions",description:"Current subscription states and providers.",columns:[{key:"status",label:"Status"},{key:"provider",label:"Provider"},{key:"current_period_end",label:"Period end"}],query:()=>platform("subscriptions","status, provider, current_period_end")}),
 definition({id:"activity",title:"Activity",description:"Audited operator actions.",columns:[{key:"action",label:"Action"},{key:"target_type",label:"Target"},{key:"created_at",label:"Time"}],query:()=>platform("platform_audit_logs","action, target_type, created_at")}),
 definition({id:"growth",title:"Growth",description:"Monthly new-clinic totals.",columns:[{key:"month",label:"Month"},{key:"new_clinics",label:"New clinics"}],query:growth}),
];
export const operatorReportRegistry=new Map(reports.map(r=>[r.id,r]));export const operatorReports=reports;
