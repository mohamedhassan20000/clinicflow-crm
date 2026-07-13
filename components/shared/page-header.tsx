import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type PageHeaderBreadcrumb = {
  label: string;
  href?: string;
};

export function PageHeader({
  title,
  description,
  back,
  breadcrumbs = [],
  leading,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  back: { href: string; label: string };
  breadcrumbs?: readonly PageHeaderBreadcrumb[];
  leading?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("space-y-3", className)}>
      <Link
        href={back.href}
        aria-label={`Back to ${back.label}`}
        className="inline-flex min-h-11 items-center gap-1 rounded-md pe-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring print:hidden"
      >
        <ChevronLeft className="size-4 rtl:hidden" aria-hidden="true" />
        <ChevronRight className="hidden size-4 rtl:block" aria-hidden="true" />
        <span>Back to {back.label}</span>
      </Link>

      {breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb" className="print:hidden">
          <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            {breadcrumbs.map((item, index) => {
              const current = index === breadcrumbs.length - 1;
              return (
                <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
                  {index > 0 ? <span aria-hidden="true">/</span> : null}
                  {current || !item.href ? (
                    <span aria-current={current ? "page" : undefined} className={cn(current && "font-medium text-foreground")}>
                      {item.label}
                    </span>
                  ) : (
                    <Link
                      href={item.href}
                      className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {item.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {leading}
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <div className="mt-1 text-sm text-muted-foreground">{description}</div>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div> : null}
      </div>
    </header>
  );
}
