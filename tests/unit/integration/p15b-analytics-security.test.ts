import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

vi.mock("server-only", () => ({}));
const url=process.env.LOCAL_SUPABASE_URL??"http://127.0.0.1:54321";
const secret=process.env.LOCAL_SUPABASE_SECRET_KEY!;
const publishable=process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY!;
if(!secret||!publishable)throw new Error("Local Supabase keys are required");
process.env.NEXT_PUBLIC_SUPABASE_URL=url; process.env.SUPABASE_SERVICE_ROLE_KEY=secret;
const service=createClient<Database>(url,secret,{auth:{persistSession:false}}), anon=createClient<Database>(url,publishable,{auth:{persistSession:false}});
const ids:string[]=[], users:string[]=[]; let basic:string, pro:string;
const now=new Date(), current=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),5)).toISOString(), previous=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,5)).toISOString();
beforeAll(async()=>{const plans=await service.from("plans").select("id, slug").in("slug",["basic","pro"]);basic=plans.data!.find(p=>p.slug==="basic")!.id;pro=plans.data!.find(p=>p.slug==="pro")!.id;
 for(let i=0;i<5;i++){const c=await service.from("clinics").insert({name:`P15B Aggregate ${crypto.randomUUID()}`}).select("id").single();ids.push(c.data!.id);await service.from("clinics").update({created_at:i<3?current:previous}).eq("id",c.data!.id);const u=await service.auth.admin.createUser({email:`p15b-${crypto.randomUUID()}@example.com`,password:"Testing123!",email_confirm:true});users.push(u.data.user!.id);await service.from("profiles").insert({id:u.data.user!.id,clinic_id:c.data!.id,full_name:"Aggregate User",role:"admin",created_at:i<4?current:previous});}
 const future=new Date(Date.now()+86400000*30).toISOString(),past=new Date(Date.now()-86400000).toISOString();
 await service.from("subscriptions").insert([{clinic_id:ids[0],plan_id:pro,status:"active",current_period_end:future},{clinic_id:ids[1],plan_id:basic,status:"active",current_period_end:past},{clinic_id:ids[2],plan_id:basic,status:"trialing",trial_ends_at:future},{clinic_id:ids[3],plan_id:basic,status:"trialing",trial_ends_at:past},{clinic_id:ids[4],plan_id:basic,status:"cancelled"}]);
});
afterAll(async()=>{await service.from("subscriptions").delete().in("clinic_id",ids);await service.from("profiles").delete().in("id",users);await service.from("clinics").delete().in("id",ids);for(const id of users)await service.auth.admin.deleteUser(id)});

describe("P1.5B aggregate reconciliation and no-PHI boundary",()=>{
 it("uses exact head counts and excludes lapsed billing states",async()=>{const {getExactActiveRevenueUsd,getOperatorAggregateInputs}=await import("@/lib/supabase/admin");const [paid,trials,currentClinics,previousClinics,currentUsers,previousUsers]=await getOperatorAggregateInputs();expect(paid.data).toBeNull();expect(trials.data).toBeNull();expect(paid.count).toBeGreaterThanOrEqual(1);expect(trials.count).toBeGreaterThanOrEqual(1);const rawPaid=await service.from("subscriptions").select("clinic_id",{count:"exact",head:true}).in("clinic_id",ids).eq("status","active").gt("current_period_end",now.toISOString());expect(rawPaid.count).toBe(1);const rawTrials=await service.from("subscriptions").select("clinic_id",{count:"exact",head:true}).in("clinic_id",ids).eq("status","trialing").gt("trial_ends_at",now.toISOString());expect(rawTrials.count).toBe(1);const revenue=await getExactActiveRevenueUsd();expect(revenue.error).toBeNull();expect(revenue.data).toBeGreaterThanOrEqual(0);expect((currentClinics.count??0)-(previousClinics.count??0)).toBeGreaterThanOrEqual(1);expect((currentUsers.count??0)-(previousUsers.count??0)).toBeGreaterThanOrEqual(1)});
 it("reconciles every headline count and revenue with raw platform tables",async()=>{
  const {getExactActiveRevenueUsd,getOperatorAggregateInputs}=await import("@/lib/supabase/admin");
  const [paid,trials,currentClinics,previousClinics,currentUsers,previousUsers]=await getOperatorAggregateInputs();
  const nowIso=new Date().toISOString(),monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString(),previousStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString();
  const raw=await Promise.all([
   service.from("subscriptions").select("id",{count:"exact",head:true}).eq("status","active").or(`current_period_end.is.null,current_period_end.gt.${nowIso}`),
   service.from("subscriptions").select("id",{count:"exact",head:true}).eq("status","trialing").gt("trial_ends_at",nowIso),
   service.from("clinics").select("id",{count:"exact",head:true}).gte("created_at",monthStart),
   service.from("clinics").select("id",{count:"exact",head:true}).gte("created_at",previousStart).lt("created_at",monthStart),
   service.from("profiles").select("id",{count:"exact",head:true}).gte("created_at",monthStart),
   service.from("profiles").select("id",{count:"exact",head:true}).gte("created_at",previousStart).lt("created_at",monthStart),
  ]);
  expect([paid.count,trials.count,currentClinics.count,previousClinics.count,currentUsers.count,previousUsers.count]).toEqual(raw.map(r=>r.count));
  expect((paid.count??0)+(trials.count??0)).toBe((raw[0].count??0)+(raw[1].count??0));
  const plans=await service.from("plans").select("id, monthly_price_usd");let expectedRevenue=0;
  for(const plan of plans.data??[]){const count=await service.from("subscriptions").select("id",{count:"exact",head:true}).eq("plan_id",plan.id).eq("status","active").or(`current_period_end.is.null,current_period_end.gt.${nowIso}`);expectedRevenue+=(count.count??0)*Number(plan.monthly_price_usd)}
  expect((await getExactActiveRevenueUsd()).data).toBe(expectedRevenue);
 });
 it("reviewed helpers return metadata only and anonymous/operator-less clients receive no PHI",async()=>{const {listOperatorClinicMetadata,listOperatorUserCounts}=await import("@/lib/supabase/admin");const clinics=await listOperatorClinicMetadata(),counts=await listOperatorUserCounts();expect(Object.keys(clinics.data![0]).sort()).toEqual(["country","created_at","id","name"]);expect(Object.keys(counts.data![0]).sort()).toEqual(["clinic_name","latest_signup","user_count"]);for(const table of ["patients","appointments","medical_notes","patient_documents","medical_note_attachments","outstanding_settlements"] as const){const result=await anon.from(table).select("*");expect(result.data??[]).toEqual([])}});
});
