"use client";

import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { OperatorActionForm } from "@/components/operator/operator-action-form";
import {
  removeClinicAiAllowanceOverride,
  setClinicAiAllowanceOverride,
} from "@/actions/operator";

/**
 * The two owner actions on one clinic's included AI allowance.
 *
 * Setting a value writes a per-clinic override; removing it deletes the override
 * and returns the clinic to the plan default. "Remove" is offered only when an
 * override actually exists, so the control can never suggest that a clinic on
 * the plan default has something to undo, and the plan default is always shown
 * as the placeholder so the owner can see what removing would restore.
 */
export function AllowanceOverrideControls({
  clinicId,
  planDefaultUsd,
  overrideUsd,
}: {
  clinicId: string;
  planDefaultUsd: number;
  overrideUsd: number | null;
}) {
  const t = useTranslations("operator");
  const inputId = `allowance-override-${clinicId}`;

  return (
    <div className="space-y-2">
      <OperatorActionForm
        action={setClinicAiAllowanceOverride}
        submitLabel={overrideUsd === null ? t("aiAllowanceSetOverride") : t("aiAllowanceUpdateOverride")}
        submitVariant="outline"
        className="space-y-2"
      >
        <input type="hidden" name="clinicId" value={clinicId} />
        <input type="hidden" name="reason" value="support_adjustment" />
        <label htmlFor={inputId} className="sr-only">
          {t("aiAllowanceOverrideUsd")}
        </label>
        <Input
          id={inputId}
          name="includedAllowanceUsd"
          type="number"
          min="0.000001"
          max="1000000"
          step="0.01"
          required
          dir="ltr"
          className="h-8 w-32 text-xs"
          defaultValue={overrideUsd === null ? "" : String(overrideUsd)}
          placeholder={planDefaultUsd.toFixed(2)}
          aria-describedby={`${inputId}-hint`}
        />
        <p id={`${inputId}-hint`} className="text-xs text-muted-foreground" dir="ltr">
          {t("aiAllowancePlanDefaultIs", { amount: `$${planDefaultUsd.toFixed(2)}` })}
        </p>
      </OperatorActionForm>

      {overrideUsd !== null ? (
        <OperatorActionForm
          action={removeClinicAiAllowanceOverride}
          submitLabel={t("aiAllowanceRemoveOverride")}
          submitVariant="secondary"
          className="space-y-1"
        >
          <input type="hidden" name="clinicId" value={clinicId} />
        </OperatorActionForm>
      ) : null}
    </div>
  );
}
