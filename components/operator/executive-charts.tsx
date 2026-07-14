"use client";
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useTranslations } from "next-intl";

const COLORS = ["#0f766e", "#2dd4bf", "#cbd5e1"];
export function ExecutiveCharts({ mix, growth }: { mix: Array<{ name: string; value: number }>; growth: Array<{ month: string; clinics: number }> }) {
  const t = useTranslations("operator");
  return <div className="grid gap-6 lg:grid-cols-2"><section className="rounded-2xl border bg-card p-5 shadow-sm"><h2 className="font-semibold">{t("subscriptionMix")}</h2><div className="h-64"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={mix} dataKey="value" nameKey="name" innerRadius={62} outerRadius={92} paddingAngle={3}>{mix.map((entry, index) => <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer></div></section><section className="rounded-2xl border bg-card p-5 shadow-sm"><h2 className="font-semibold">{t("clinicGrowth")}</h2><div className="h-64"><ResponsiveContainer width="100%" height="100%"><AreaChart data={growth}><defs><linearGradient id="clinicGrowth" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#0f766e" stopOpacity={0.35}/><stop offset="95%" stopColor="#0f766e" stopOpacity={0}/></linearGradient></defs><XAxis dataKey="month" axisLine={false} tickLine={false}/><YAxis allowDecimals={false} axisLine={false} tickLine={false}/><Tooltip/><Area type="monotone" dataKey="clinics" stroke="#0f766e" fill="url(#clinicGrowth)" strokeWidth={3}/></AreaChart></ResponsiveContainer></div></section></div>;
}
