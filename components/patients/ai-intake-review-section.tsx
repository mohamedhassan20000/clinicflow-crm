"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Bot, ExternalLink, Eye } from "lucide-react";
import {
  approveAiPatientIntake,
  rejectAiPatientIntake,
} from "@/actions/ai-patient-intakes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AI_INTAKE_ID_PARAM,
  AI_INTAKE_REVIEW_ANCHOR,
  AI_INTAKE_REVIEW_PARAM,
} from "@/lib/navigation/ai-review-targets";

export type AiPatientIntakeListItem = {
  id: string;
  conversationId: string;
  fullName: string;
  dateOfBirth: string;
  phone: string;
  email: string;
  nationalId: string;
  departmentName: string;
  doctorName: string;
  createdAt: string;
  hasAppointmentRequest: boolean;
};

export function AiIntakeReviewSection({ intakes }: { intakes: AiPatientIntakeListItem[] }) {
  const t = useTranslations("protected");
  const searchParams = useSearchParams();
  const reviewRequested = searchParams.get(AI_INTAKE_REVIEW_PARAM) === "1";
  const linkedIntakeId = searchParams.get(AI_INTAKE_ID_PARAM);
  const [rows, setRows] = useState(intakes);
  const [reviewingId, setReviewingId] = useState<string | null>(() =>
    reviewRequested && linkedIntakeId && intakes.some((row) => row.id === linkedIntakeId)
      ? linkedIntakeId
      : null,
  );
  const [pending, startTransition] = useTransition();

  const cardRef = useRef<HTMLDivElement | null>(null);
  // One scroll per arrival. Without the latch, any later render that changes
  // the search params — approving a row, a router refresh — yanks the page.
  const scrolledRef = useRef(false);

  // P10 — arriving here from the dashboard shortcut.
  //
  // The fragment in the URL is kept because it is the right thing for a copied
  // link, but it cannot be relied on: this table is the last thing on a
  // streamed server page, so at the moment the App Router would act on the
  // fragment the element frequently does not exist yet and the staff member
  // lands at the top of a long patient list instead. The query parameter is
  // read here, after mount, when the card demonstrably exists.
  //
  // Focus as well as scroll: a keyboard user who followed the shortcut should
  // be *in* the review table, not merely looking at it.
  useEffect(() => {
    if (!reviewRequested) return;
    if (scrolledRef.current) return;
    scrolledRef.current = true;
    const target = linkedIntakeId
      ? document.getElementById(`ai-intake-${linkedIntakeId}`)
      : null;
    const card = cardRef.current;
    if (!card) return;
    const focusTarget = target ?? card;
    focusTarget.scrollIntoView({ behavior: "smooth", block: target ? "center" : "start" });
    focusTarget.focus({ preventScroll: true });
  }, [linkedIntakeId, reviewRequested]);

  if (rows.length === 0) return null;

  const approve = (id: string) => {
    startTransition(async () => {
      const result = await approveAiPatientIntake(id);
      if (result.error) {
        toast.error(t(result.error));
        return;
      }
      setRows((current) => current.filter((item) => item.id !== id));
      toast.success(t("aiIntakeApproved"));
    });
  };

  const reject = (id: string) => {
    startTransition(async () => {
      const result = await rejectAiPatientIntake(id);
      if (result.error) {
        toast.error(t(result.error));
        return;
      }
      setRows((current) => current.filter((item) => item.id !== id));
      toast.success(t("aiIntakeRejected"));
    });
  };


  return (
    <Card
      id={AI_INTAKE_REVIEW_ANCHOR}
      ref={cardRef}
      tabIndex={-1}
      className="scroll-mt-20 outline-none print:hidden"
    >
      <CardHeader>
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-primary" aria-hidden="true" />
          <CardTitle>{t("aiPatientIntakesAwaitingReview")}</CardTitle>
          <Badge variant="secondary">{rows.length}</Badge>
        </div>
        <CardDescription>{t("aiPatientIntakesAwaitingReviewDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("patient")}</TableHead>
              <TableHead>{t("department")}</TableHead>
              <TableHead>{t("doctor")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead className="text-end">{t("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((intake) => (
              <TableRow
                key={intake.id}
                id={`ai-intake-${intake.id}`}
                data-intake-id={intake.id}
                tabIndex={-1}
                className={"scroll-mt-20 outline-none" /* i18n-allow: Tailwind utility classes, not user-facing copy */}
              >
                <TableCell>
                  <div className="font-medium">{intake.fullName}</div>
                  <div className="text-xs text-muted-foreground" dir="ltr">{intake.phone}</div>
                </TableCell>
                <TableCell>{intake.departmentName}</TableCell>
                <TableCell>{intake.doctorName}</TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {intake.hasAppointmentRequest
                      ? t("aiIntakeWithPendingAppointment")
                      : t("awaitingReview")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Dialog
                      open={reviewingId === intake.id}
                      onOpenChange={(open) => setReviewingId(open ? intake.id : null)}
                    >
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Eye aria-hidden="true" />
                          {t("review")}
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="sm:max-w-lg">
                        <DialogHeader>
                          <DialogTitle>{intake.fullName}</DialogTitle>
                          <DialogDescription>{t("aiIntakeFullDetails")}</DialogDescription>
                        </DialogHeader>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                          <dt className="text-muted-foreground">{t("dateOfBirth")}</dt><dd>{intake.dateOfBirth}</dd>
                          <dt className="text-muted-foreground">{t("phone")}</dt><dd dir="ltr">{intake.phone}</dd>
                          <dt className="text-muted-foreground">{t("email")}</dt><dd className="break-all" dir="ltr">{intake.email}</dd>
                          <dt className="text-muted-foreground">{t("nationalId")}</dt><dd dir="ltr">{intake.nationalId}</dd>
                          <dt className="text-muted-foreground">{t("department")}</dt><dd>{intake.departmentName}</dd>
                          <dt className="text-muted-foreground">{t("doctor")}</dt><dd>{intake.doctorName}</dd>
                          <dt className="text-muted-foreground">{t("createdBy")}</dt><dd>{t("aiAssistant")}</dd>
                        </dl>
                        <DialogFooter>
                          <Button asChild variant="outline">
                            <Link href={`/inbox?conversation=${intake.conversationId}`}>
                              <ExternalLink className="rtl:-scale-x-100" aria-hidden="true" />
                              {t("openConversation")}
                            </Link>
                          </Button>
                          <Button disabled={pending} onClick={() => approve(intake.id)}>{t("approve")}</Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive" size="sm" disabled={pending}>{t("reject")}</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("rejectAiIntakeTitle")}</AlertDialogTitle>
                          <AlertDialogDescription>{t("rejectAiIntakeDescription")}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                          <AlertDialogAction variant="destructive" onClick={() => reject(intake.id)}>{t("reject")}</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    <Button size="sm" disabled={pending} onClick={() => approve(intake.id)}>{t("approve")}</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
