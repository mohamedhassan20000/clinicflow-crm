import "server-only";
import { requirePlatformAdmin } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { getExactActiveRevenueUsd, getOperatorAggregateInputs } from "@/lib/supabase/admin";
export type OperatorAnalytics={activeClinics:number;trialClinics:number;paidClinics:number;revenueUsd:number;monthlyGrowth:number;userGrowth:number;clinicGrowth:number;subscriptionMix:Array<{name:string;value:number}>;clinicSeries:Array<{month:string;clinics:number}>;recentActivity:Array<{id:string;action:string;createdAt:string;targetType:string}>};
const change=(a:number,b:number)=>b===0?(a>0?100:0):((a-b)/b)*100;
export async function getOperatorAnalytics():Promise<OperatorAnalytics>{
 await requirePlatformAdmin(); const [paid,trials,currentClinics,previousClinics,currentUsers,previousUsers,clinicRows]=await getOperatorAggregateInputs();
 if([paid,trials,currentClinics,previousClinics,currentUsers,previousUsers,clinicRows].some(r=>r.error))throw new Error("Operator analytics could not be loaded.");
 const now=new Date(),revenue=await getExactActiveRevenueUsd();if(revenue.error)throw new Error("Operator revenue could not be loaded.");
 const series=Array.from({length:6},(_,i)=>{const d=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-5+i,1)),n=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));return{month:d.toISOString().slice(0,7),clinics:(clinicRows.data??[]).filter(r=>new Date(r.created_at)>=d&&new Date(r.created_at)<n).length}});
 const db=await createClient(),activity=await db.from("platform_audit_logs").select("id, action, target_type, created_at").order("created_at",{ascending:false}).limit(8);
 return{activeClinics:(paid.count??0)+(trials.count??0),trialClinics:trials.count??0,paidClinics:paid.count??0,revenueUsd:revenue.data??0,monthlyGrowth:change(currentClinics.count??0,previousClinics.count??0),userGrowth:change(currentUsers.count??0,previousUsers.count??0),clinicGrowth:change(currentClinics.count??0,previousClinics.count??0),subscriptionMix:[{name:"Paid",value:paid.count??0},{name:"Trial",value:trials.count??0}],clinicSeries:series,recentActivity:(activity.data??[]).map(r=>({id:r.id,action:r.action,targetType:r.target_type,createdAt:r.created_at}))};
}
