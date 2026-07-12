"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowRight, CalendarCheck, Check, FileHeart, LineChart, LockKeyhole, Menu, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { marketingCopy as copy } from "@/lib/marketing-copy";

type Props = { registrationMode: string; weeklyLimit: number; acceptedThisWeek: number };

const featureIcons = [CalendarCheck, FileHeart, LineChart] as const;
const navigation = [["#product", copy.nav.product], ["#features", copy.nav.features], ["#pricing", copy.nav.pricing], ["#faq", copy.nav.faq], ["#contact", copy.nav.contact]] as const;
const EarlyAccessForm = dynamic(
  () => import("@/components/auth/early-access-form").then((module) => module.EarlyAccessForm),
  { ssr: false },
);

export function MarketingPage({ registrationMode, weeklyLimit, acceptedThisWeek }: Props) {
  const percentage = Math.min(100, Math.round((acceptedThisWeek / Math.max(weeklyLimit, 1)) * 100));
  return (
    <main className="marketing-page min-h-dvh overflow-hidden bg-[#f7faf9] text-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-900/5 bg-[#f7faf9]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-18 max-w-7xl items-center justify-between px-5 lg:px-8">
          <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight"><span className="grid size-9 place-items-center rounded-xl bg-teal-900 text-white"><Sparkles className="size-4" /></span>{copy.brand}</Link>
          <nav aria-label={copy.nav.label} className="hidden items-center gap-7 text-sm text-slate-600 md:flex">
            {navigation.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
          </nav>
          <div className="flex items-center gap-2"><Button variant="ghost" asChild><Link href="/login">{copy.nav.login}</Link></Button><Sheet><SheetTrigger asChild><Button variant="ghost" size="icon" className="md:hidden" aria-label={copy.nav.menu}><Menu className="size-5" /></Button></SheetTrigger><SheetContent side="right"><SheetHeader><SheetTitle>{copy.nav.menuTitle}</SheetTitle></SheetHeader><nav aria-label={copy.nav.label} className="flex flex-col px-4">{navigation.map(([href, label]) => <SheetClose asChild key={href}><Link className="rounded-lg px-3 py-3 text-base font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={href}>{label}</Link></SheetClose>)}</nav></SheetContent></Sheet></div>
        </div>
      </header>

      <section className="relative mx-auto grid min-h-[760px] max-w-7xl items-center gap-14 px-5 py-20 lg:grid-cols-[1.05fr_.95fr] lg:px-8">
        <div className="marketing-reveal relative z-10">
          <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-teal-900/10 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[.16em] text-teal-900"><span className="size-1.5 rounded-full bg-teal-500" />{copy.hero.eyebrow}</p>
          <h1 className="max-w-3xl font-display text-6xl leading-[.95] tracking-[-.045em] text-balance sm:text-7xl lg:text-[6.4rem]">{copy.hero.title}</h1>
          <p className="mt-7 max-w-xl text-lg leading-8 text-slate-600">{copy.hero.body}</p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row"><Button size="lg" className="h-12 rounded-full bg-teal-900 px-7 hover:bg-teal-800" asChild><Link href="/login">{copy.hero.primary}<ArrowRight className="size-4" /></Link></Button><Button size="lg" variant="outline" className="h-12 rounded-full bg-white px-7" asChild><Link href="#early-access">{copy.hero.secondary}</Link></Button></div>
          <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-500">{copy.hero.assurances.map((item) => <span key={item} className="flex items-center gap-2"><Check className="size-4 text-teal-700" />{item}</span>)}</div>
        </div>
        <div className="marketing-float relative">
          <div className="absolute -inset-20 -z-10 rounded-full bg-[radial-gradient(circle,#99f6e4_0%,transparent_65%)] opacity-60" />
          <div className="rotate-1 rounded-[2rem] border border-white/80 bg-white/80 p-3 shadow-[0_40px_100px_-35px_rgba(15,118,110,.35)] backdrop-blur">
            <div className="rounded-[1.5rem] bg-slate-950 p-6 text-white"><div className="flex items-center justify-between"><div><p className="text-xs text-teal-300">{copy.hero.preview.date}</p><p className="mt-1 text-xl font-semibold">{copy.hero.preview.greeting}</p></div><div className="size-10 rounded-full bg-teal-300/20" /></div><div className="mt-8 grid grid-cols-3 gap-3">{copy.hero.preview.metrics.map(([value,label])=><div key={label} className="rounded-xl bg-white/8 p-4"><p className="text-2xl font-semibold">{value}</p><p className="mt-1 text-[11px] text-slate-400">{label}</p></div>)}</div></div>
            <div className="grid gap-3 p-3 sm:grid-cols-2"><div className="rounded-2xl border bg-white p-5"><p className="text-xs font-medium text-slate-500">{copy.hero.preview.flowTitle}</p><div className="mt-5 space-y-4">{copy.hero.preview.appointments.map((appointment,index)=><div key={appointment} className="flex items-center gap-3 text-sm"><span className={`size-2 rounded-full ${index===0?'bg-teal-500':'bg-amber-400'}`} />{appointment}</div>)}</div></div><div className="rounded-2xl bg-teal-50 p-5"><Users className="size-5 text-teal-800"/><p className="mt-7 text-3xl font-semibold">{copy.hero.preview.patientsValue}</p><p className="text-sm text-slate-600">{copy.hero.preview.patientsLabel}</p></div></div>
          </div>
        </div>
      </section>

      <section id="product" className="bg-teal-950 px-5 py-24 text-white"><div className="mx-auto max-w-7xl"><p className="text-sm font-semibold uppercase tracking-[.18em] text-teal-300">{copy.product.eyebrow}</p><div className="mt-5 grid gap-10 lg:grid-cols-2"><h2 className="font-display text-5xl leading-tight text-balance sm:text-6xl">{copy.product.title}</h2><p className="max-w-xl text-lg leading-8 text-teal-50/70">{copy.product.body}</p></div></div></section>

      <section id="features" className="mx-auto max-w-7xl px-5 py-24 lg:px-8"><div className="max-w-2xl"><p className="text-sm font-semibold text-teal-800">{copy.features.eyebrow}</p><h2 className="mt-3 font-display text-5xl tracking-tight">{copy.features.title}</h2></div><div className="mt-14 grid gap-5 md:grid-cols-3">{copy.features.items.map(({title,body}, index)=>{const Icon=featureIcons[index];return <article key={title} className="marketing-card rounded-3xl border border-slate-200/70 bg-white p-7 shadow-sm"><span className="grid size-12 place-items-center rounded-2xl bg-teal-50 text-teal-800"><Icon /></span><h3 className="mt-8 text-xl font-semibold">{title}</h3><p className="mt-3 leading-7 text-slate-600">{body}</p></article>})}</div></section>

      <section className="mx-auto max-w-7xl px-5 pb-24 lg:px-8"><div className="grid overflow-hidden rounded-[2rem] bg-amber-50 lg:grid-cols-2"><div className="p-8 sm:p-14"><p className="text-sm font-semibold text-amber-800">{copy.trust.eyebrow}</p><h2 className="mt-4 font-display text-5xl">{copy.trust.title}</h2><p className="mt-5 leading-7 text-slate-600">{copy.trust.body}</p><div className="mt-8 flex items-center gap-3 text-sm font-medium"><LockKeyhole className="text-teal-800"/>{copy.trust.assurance}</div></div><div className="grid place-items-center bg-[linear-gradient(135deg,#0f766e,#042f2e)] p-12"><div className="w-full max-w-sm space-y-3">{copy.trust.roles.map((role)=><div key={role.name} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/10 p-4 text-white backdrop-blur"><span>{role.name}</span><span className="text-xs text-teal-200">{role.access}</span></div>)}</div></div></div></section>

      <section id="pricing" className="border-y bg-white px-5 py-24 text-center"><div className="mx-auto max-w-3xl"><p className="text-sm font-semibold text-teal-800">{copy.pricing.eyebrow}</p><h2 className="mt-3 font-display text-5xl">{copy.pricing.title}</h2><p className="mx-auto mt-5 max-w-xl leading-7 text-slate-600">{copy.pricing.body}</p><Button className="mt-8 rounded-full" variant="outline" asChild><Link href="#early-access">{copy.pricing.cta}</Link></Button></div></section>

      <section id="early-access" className="mx-auto max-w-7xl px-5 py-24 lg:px-8"><div className="relative overflow-hidden rounded-[2.5rem] bg-slate-950 px-7 py-16 text-white sm:px-16"><div className="absolute end-0 top-0 size-80 translate-x-1/3 -translate-y-1/3 rounded-full bg-teal-400/20 blur-3xl"/><div className="relative grid items-center gap-10 lg:grid-cols-[1fr_auto]"><div><p className="text-sm font-semibold text-teal-300">{copy.earlyAccess.eyebrow}</p><h2 className="mt-3 max-w-2xl font-display text-5xl">{copy.earlyAccess.title}</h2><p className="mt-5 max-w-xl text-slate-300">{copy.earlyAccess.body}</p><div className="mt-7 max-w-md"><div className="flex justify-between text-xs text-slate-400"><span>{copy.earlyAccess.progress(acceptedThisWeek, weeklyLimit)}</span><span>{percentage}%</span></div><div className="mt-2 h-1.5 rounded-full bg-white/10"><div className="h-full rounded-full bg-teal-300" style={{width:`${percentage}%`}} /></div></div></div>
          {registrationMode === "open" ? <Button size="lg" className="relative h-12 rounded-full bg-white px-7 text-slate-950 hover:bg-teal-50" asChild><Link href="/signup">{copy.earlyAccess.openButton}</Link></Button> : <Dialog><DialogTrigger asChild><Button size="lg" className="relative h-12 rounded-full bg-white px-7 text-slate-950 hover:bg-teal-50">{copy.earlyAccess.button}<ArrowRight /></Button></DialogTrigger><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle className="text-2xl">{copy.earlyAccess.dialogTitle}</DialogTitle><DialogDescription>{copy.earlyAccess.dialogDescription}</DialogDescription></DialogHeader><EarlyAccessForm mode="dialog" /></DialogContent></Dialog>}
        </div></div></section>

      <section id="faq" className="mx-auto grid max-w-7xl gap-12 px-5 py-24 lg:grid-cols-[.7fr_1.3fr] lg:px-8"><div><p className="text-sm font-semibold text-teal-800">{copy.faq.eyebrow}</p><h2 className="mt-3 font-display text-5xl">{copy.faq.title}</h2></div><div className="divide-y border-y">{copy.faq.items.map(({question,answer})=><details key={question} className="group py-6"><summary className="cursor-pointer list-none text-lg font-semibold">{question}<span className="float-right text-teal-700 group-open:rotate-45">{copy.faq.expand}</span></summary><p className="mt-3 max-w-2xl leading-7 text-slate-600">{answer}</p></details>)}</div></section>

      <footer id="contact" className="border-t bg-white px-5 py-12"><div className="mx-auto flex max-w-7xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">{copy.brand}</p><p className="mt-1 text-sm text-slate-500">{copy.footer.tagline}</p></div><div className="flex gap-6 text-sm text-slate-600"><a href={`mailto:${copy.footer.email}`}>{copy.footer.email}</a><Link href="/login">{copy.footer.login}</Link></div></div></footer>
    </main>
  );
}
