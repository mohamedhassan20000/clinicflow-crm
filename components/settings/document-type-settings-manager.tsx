"use client";

import { useState, useTransition } from "react";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  saveDocumentSettings,
  resetDocumentSettings,
  type DocumentTypeSettingsView,
} from "@/actions/documents-settings";
import type { StoredDocumentSettings } from "@/lib/documents/settings-config";
import { DOCUMENT_WATERMARK_MAX_LENGTH } from "@/lib/documents/settings-config";
import type { RegisteredDocumentTypeCode } from "@/lib/documents/catalog";

type EditorState = {
  watermarkEnabled: boolean;
  watermarkText: string;
  qrEnabled: boolean;
  numberingPrefix: string;
  numberingYearlyReset: boolean;
  includeAttachments: boolean;
  supportsAttachments: boolean;
};

type EditTarget =
  | { kind: "global"; state: EditorState }
  | {
      kind: "type";
      code: RegisteredDocumentTypeCode;
      title: string;
      hasOverride: boolean;
      state: EditorState;
    };

function stateFromGlobal(global: StoredDocumentSettings): EditorState {
  return {
    watermarkEnabled: global.watermarkEnabled,
    watermarkText: global.watermarkText ?? "",
    qrEnabled: global.qrEnabled,
    numberingPrefix: global.numberingPrefix ?? "",
    numberingYearlyReset: global.numberingYearlyReset,
    includeAttachments: global.printOptions.includeAttachments ?? false,
    supportsAttachments: false,
  };
}

function stateFromType(row: DocumentTypeSettingsView): EditorState {
  return {
    watermarkEnabled: row.watermarkEnabled,
    watermarkText: row.watermarkText ?? "",
    qrEnabled: row.qrEnabled,
    // Show the effective prefix so an admin edits from the real starting value.
    numberingPrefix: row.hasOverride ? row.numberingPrefix : "",
    numberingYearlyReset: row.numberingYearlyReset,
    includeAttachments: row.includeAttachments,
    supportsAttachments: row.supportsAttachments,
  };
}

export function DocumentTypeSettingsManager({
  global,
  types,
  archetypeLabels,
  typeLabels,
}: {
  global: StoredDocumentSettings;
  types: DocumentTypeSettingsView[];
  archetypeLabels: Record<string, string>;
  typeLabels: Record<string, string>;
}) {
  const t = useTranslations("documents.settings");
  const [target, setTarget] = useState<EditTarget | null>(null);
  const [pending, startTransition] = useTransition();

  function openGlobal() {
    setTarget({ kind: "global", state: stateFromGlobal(global) });
  }

  function openType(row: DocumentTypeSettingsView) {
    setTarget({
      kind: "type",
      code: row.code,
      title: typeLabels[row.code] ?? row.code,
      hasOverride: row.hasOverride,
      state: stateFromType(row),
    });
  }

  function patch(next: Partial<EditorState>) {
    setTarget((current) =>
      current ? { ...current, state: { ...current.state, ...next } } : current,
    );
  }

  function save() {
    if (!target) return;
    const { state } = target;
    startTransition(async () => {
      const result = await saveDocumentSettings({
        docType: target.kind === "global" ? null : target.code,
        watermarkEnabled: state.watermarkEnabled,
        watermarkText: state.watermarkText,
        qrEnabled: state.qrEnabled,
        numberingPrefix: state.numberingPrefix,
        numberingYearlyReset: state.numberingYearlyReset,
        printOptions: state.supportsAttachments
          ? { includeAttachments: state.includeAttachments }
          : {},
      });
      if (result.error) toast.error(result.error);
      else {
        toast.success(t("saved"));
        setTarget(null);
      }
    });
  }

  function reset() {
    if (!target) return;
    startTransition(async () => {
      const result = await resetDocumentSettings({
        docType: target.kind === "global" ? null : target.code,
      });
      if (result.error) toast.error(result.error);
      else {
        toast.success(t("resetDone"));
        setTarget(null);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t("perTypeTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("perTypeDescription")}</p>
        </div>
        <Button type="button" variant="outline" onClick={openGlobal}>
          {t("editGlobalDefaults")}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/50">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colType")}</TableHead>
              <TableHead>{t("colWatermark")}</TableHead>
              <TableHead>{t("colQr")}</TableHead>
              <TableHead>{t("colPrefix")}</TableHead>
              <TableHead className="text-end">{t("colNextNumber")}</TableHead>
              <TableHead className="text-end">{t("colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {types.map((row) => (
              <TableRow key={row.code}>
                <TableCell>
                  <div className="font-medium">{typeLabels[row.code] ?? row.code}</div>
                  <div className="text-xs text-muted-foreground">
                    {archetypeLabels[row.archetype] ?? row.archetype}
                    {row.hasOverride ? (
                      <Badge variant="secondary" className="ms-2">
                        {t("overridden")}
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  {row.watermarkEnabled ? (
                    <span className="text-sm">
                      {row.watermarkText ?? t("watermarkClinicName")}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">{t("off")}</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-sm">{row.qrEnabled ? t("on") : t("off")}</span>
                </TableCell>
                <TableCell>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {row.numberingPrefix}
                  </code>
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {row.numberingPrefix}-
                  {String(row.nextSequence).padStart(row.sequencePadding, "0")}
                </TableCell>
                <TableCell className="text-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openType(row)}
                  >
                    {t("configure")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Sheet open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {target ? (
            <>
              <SheetHeader>
                <SheetTitle>
                  {target.kind === "global"
                    ? t("editGlobalDefaults")
                    : target.title}
                </SheetTitle>
                <SheetDescription>
                  {target.kind === "global"
                    ? t("globalDescription")
                    : t("typeDescription")}
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-5 px-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label>{t("watermark")}</Label>
                    <p className="text-xs text-muted-foreground">{t("watermarkHint")}</p>
                  </div>
                  <Switch
                    checked={target.state.watermarkEnabled}
                    onCheckedChange={(checked) => patch({ watermarkEnabled: checked })}
                    disabled={pending}
                  />
                </div>
                {target.state.watermarkEnabled ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="doc-watermark-text">{t("watermarkText")}</Label>
                    <Input
                      id="doc-watermark-text"
                      value={target.state.watermarkText}
                      maxLength={DOCUMENT_WATERMARK_MAX_LENGTH}
                      placeholder={t("watermarkClinicName")}
                      onChange={(event) => patch({ watermarkText: event.target.value })}
                      disabled={pending}
                    />
                  </div>
                ) : null}

                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label>{t("qrCode")}</Label>
                    <p className="text-xs text-muted-foreground">{t("qrHint")}</p>
                  </div>
                  <Switch
                    checked={target.state.qrEnabled}
                    onCheckedChange={(checked) => patch({ qrEnabled: checked })}
                    disabled={pending}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="doc-prefix">{t("numberingPrefix")}</Label>
                  <Input
                    id="doc-prefix"
                    value={target.state.numberingPrefix}
                    maxLength={16}
                    placeholder={
                      target.kind === "type"
                        ? t("inheritsDefault")
                        : t("inheritsCatalog")
                    }
                    onChange={(event) =>
                      patch({ numberingPrefix: event.target.value.toUpperCase() })
                    }
                    disabled={pending}
                  />
                  <p className="text-xs text-muted-foreground">{t("prefixHint")}</p>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label>{t("yearlyReset")}</Label>
                    <p className="text-xs text-muted-foreground">{t("yearlyResetHint")}</p>
                  </div>
                  <Switch
                    checked={target.state.numberingYearlyReset}
                    onCheckedChange={(checked) =>
                      patch({ numberingYearlyReset: checked })
                    }
                    disabled={pending}
                  />
                </div>

                {target.kind === "type" && target.state.supportsAttachments ? (
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <Label>{t("includeAttachments")}</Label>
                      <p className="text-xs text-muted-foreground">
                        {t("includeAttachmentsHint")}
                      </p>
                    </div>
                    <Switch
                      checked={target.state.includeAttachments}
                      onCheckedChange={(checked) =>
                        patch({ includeAttachments: checked })
                      }
                      disabled={pending}
                    />
                  </div>
                ) : null}
              </div>

              <SheetFooter className="gap-2">
                <Button type="button" onClick={save} disabled={pending}>
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  {t("save")}
                </Button>
                {(target.kind === "global" || target.hasOverride) ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={reset}
                    disabled={pending}
                  >
                    <RotateCcw className="size-4" />
                    {target.kind === "global" ? t("resetGlobal") : t("resetToDefault")}
                  </Button>
                ) : null}
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
