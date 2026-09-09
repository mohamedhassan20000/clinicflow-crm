"use client";

import { useMemo, useState } from "react";
import { MessageCircleMore, Search, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  bulkRecipientMatches,
  type BulkRecipient,
} from "@/lib/messaging/bulk-recipients";
import { cn } from "@/lib/utils";

/**
 * Choosing who a bulk send goes to, from every list the clinic actually has.
 *
 * Selecting rows in the Inbox list only ever reached people the clinic was
 * already mid-conversation with, which is the wrong set for the thing this
 * feature is for — "the doctor is off sick today" has to reach the patients who
 * are booked in, not the ones who happened to message recently. So the picker
 * merges the Inbox threads with the WhatsApp contact directory and the clinic's
 * own patient files, deduplicated onto one row per destination number by
 * `buildBulkRecipients`.
 *
 * The source of each row is shown, because it tells staff something they act
 * on: a Conversation is a thread they can go and read, a Contact or Patient is
 * somebody a new thread will be opened with. Nothing else about the sources
 * differs by the time the message is sent.
 *
 * Rows with no usable number never reach this component — they are excluded by
 * the merge — so everything visible here can be written to.
 */
export function BulkRecipientPicker({
  recipients,
  selectedKeys,
  onChange,
  max,
}: {
  recipients: BulkRecipient[];
  selectedKeys: string[];
  onChange: (keys: string[]) => void;
  max: number;
}) {
  const t = useTranslations("inbox.bulk");
  const [query, setQuery] = useState("");

  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);

  /**
   * The visible result set, capped.
   *
   * A clinic with five hundred patient files would otherwise render five
   * hundred rows into a dialog nobody scrolls to the bottom of; the cap is
   * stated in the footer rather than silently applied, and searching narrows
   * the real set rather than the truncated one.
   */
  const matched = useMemo(
    () => recipients.filter((recipient) => bulkRecipientMatches(recipient, query)),
    [query, recipients],
  );
  const visible = matched.slice(0, VISIBLE_LIMIT);

  const toggle = (key: string) => {
    if (selected.has(key)) {
      onChange(selectedKeys.filter((current) => current !== key));
      return;
    }
    // The ceiling is the send's ceiling, enforced here so the count staff see
    // is always a count that can actually be sent.
    if (selectedKeys.length >= max) return;
    onChange([...selectedKeys, key]);
  };

  /**
   * "Select all visible" means exactly the rows on screen, and it stops at the
   * ceiling rather than quietly selecting the first N of them without saying
   * so — the button reports how many it could take.
   */
  const selectAllVisible = () => {
    const next = [...selectedKeys];
    for (const recipient of visible) {
      if (next.length >= max) break;
      if (!next.includes(recipient.key)) next.push(recipient.key);
    }
    onChange(next);
  };

  const sourceLabel: Record<BulkRecipient["source"], string> = {
    conversation: t("source.conversation"),
    contact: t("source.contact"),
    patient: t("source.patient"),
  };

  return (
    <div className="space-y-2" data-testid="bulk-recipient-picker">
      <div className="relative">
        <Search
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="ps-9"
          placeholder={t("searchRecipients")}
          aria-label={t("searchRecipients")}
          data-testid="bulk-recipient-search"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground" data-testid="bulk-recipient-count">
          {t("selectedRecipients", { count: selectedKeys.length })}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ms-auto"
          disabled={visible.length === 0 || selectedKeys.length >= max}
          onClick={selectAllVisible}
          data-testid="bulk-select-visible"
        >
          {t("selectVisible", { count: visible.length })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={selectedKeys.length === 0}
          onClick={() => onChange([])}
          data-testid="bulk-clear-selection"
        >
          {t("clearSelection")}
        </Button>
      </div>

      <div className="max-h-56 overflow-y-auto rounded-lg border">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("noRecipients")}</p>
        ) : (
          visible.map((recipient) => {
            const checked = selected.has(recipient.key);
            return (
              <button
                key={recipient.key}
                type="button"
                role="checkbox"
                aria-checked={checked}
                disabled={!checked && selectedKeys.length >= max}
                onClick={() => toggle(recipient.key)}
                className={cn(
                  "flex w-full items-center gap-3 border-b px-3 py-2 text-start last:border-b-0 transition-colors hover:bg-muted/50 disabled:opacity-50",
                  checked && "bg-primary/10",
                )}
                data-testid="bulk-recipient-row"
                data-source={recipient.source}
              >
                <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" dir="auto">
                    {recipient.name}
                  </span>
                  {/* The number stays LTR whatever the interface language. */}
                  <span className="block truncate text-xs text-muted-foreground" dir="ltr">
                    {recipient.address}
                    {recipient.fileNumber ? ` · ${recipient.fileNumber}` : ""}
                  </span>
                </span>
                <Badge variant="outline" className="shrink-0 gap-1 text-[11px]">
                  {recipient.source === "conversation" ? (
                    <MessageCircleMore className="size-3" aria-hidden />
                  ) : (
                    <UserRound className="size-3" aria-hidden />
                  )}
                  {sourceLabel[recipient.source]}
                </Badge>
              </button>
            );
          })
        )}
      </div>

      {matched.length > visible.length ? (
        <p className="text-xs text-muted-foreground" data-testid="bulk-recipient-truncated">
          {t("moreResults", { count: matched.length - visible.length })}
        </p>
      ) : null}
    </div>
  );
}

/** How many rows are rendered at once. Searching narrows the real set. */
const VISIBLE_LIMIT = 100;
