"use client";

import { useId, useState } from "react";

type FaqItem = {
  question: string;
  answer: string;
};

export function FaqAccordion({ items, expand }: { items: FaqItem[]; expand: string }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const accordionId = useId();

  return (
    <div className="divide-y divide-[var(--m-line)] border-y border-[var(--m-line)]">
      {items.map(({ question, answer }, index) => {
        const isOpen = openIndex === index;
        const triggerId = `${accordionId}-trigger-${index}`;
        const panelId = `${accordionId}-panel-${index}`;

        return (
          <div key={question} className="py-1" data-marketing-faq-item>
            <h3>
              <button
                id={triggerId}
                type="button"
                aria-controls={panelId}
                aria-expanded={isOpen}
                className="flex min-h-16 w-full cursor-pointer items-center justify-between gap-5 rounded-lg py-4 text-start text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0d9488]"
                onClick={() => setOpenIndex(isOpen ? null : index)}
              >
                {question}
                <span
                  className={`grid size-8 shrink-0 place-items-center rounded-full border border-[var(--m-line)] text-[var(--m-accent-text)] transition-transform duration-500 ease-[var(--m-motion-ease)] motion-reduce:transition-none ${isOpen ? "rotate-45" : ""}`}
                  aria-hidden="true"
                >
                  {expand}
                </span>
              </button>
            </h3>
            <div
              id={panelId}
              aria-hidden={!isOpen}
              aria-labelledby={triggerId}
              data-marketing-faq-panel
              className={`grid transition-[grid-template-rows,opacity] duration-500 ease-[var(--m-motion-ease)] motion-reduce:transition-none ${isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
            >
              <div className="min-h-0 overflow-hidden">
                <p className="max-w-3xl pb-6 pe-10 leading-7 text-[var(--m-muted)]">{answer}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
