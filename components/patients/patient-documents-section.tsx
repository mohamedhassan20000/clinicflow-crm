"use client";

import {
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type RefObject,
} from "react";
import {
  Eye,
  FileText,
  Loader2,
  Shield,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import {
  deletePatientDocument,
  getPatientDocumentSignedUrl,
  uploadPatientDocument,
  type PatientDocumentItem,
  type PatientDocumentsData,
} from "@/actions/patient-documents";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type DocumentCategory = "national_id" | "insurance" | "other";

interface PatientDocumentsSectionProps {
  patientId: string;
  initialDocuments: PatientDocumentsData;
}

const ACCEPTED_DOCUMENTS = "application/pdf,image/jpeg,image/png,image/webp";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatMime(type: string) {
  if (type === "application/pdf") return "PDF";
  if (type === "image/jpeg") return "JPG";
  if (type === "image/png") return "PNG";
  if (type === "image/webp") return "WebP";
  return "File";
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function PatientDocumentsSection({
  patientId,
  initialDocuments,
}: PatientDocumentsSectionProps) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const nationalInputRef = useRef<HTMLInputElement>(null);
  const insuranceInputRef = useRef<HTMLInputElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  const totalCount =
    (documents.nationalId ? 1 : 0) +
    (documents.insurance ? 1 : 0) +
    documents.other.length;

  function inputFor(category: DocumentCategory) {
    if (category === "national_id") return nationalInputRef;
    if (category === "insurance") return insuranceInputRef;
    return otherInputRef;
  }

  function onUpload(category: DocumentCategory, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.set("file", file);
    setPendingKey(`upload:${category}`);

    startTransition(async () => {
      const result = await uploadPatientDocument(patientId, category, formData);
      if (result.error) {
        toast.error(result.error);
      } else {
        if (result.data) setDocuments(result.data);
        toast.success("Document uploaded.");
      }
      event.target.value = "";
      setPendingKey(null);
    });
  }

  function onDelete(document: PatientDocumentItem) {
    setPendingKey(`delete:${document.id}`);
    startTransition(async () => {
      const result = await deletePatientDocument(patientId, document.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        if (result.data) setDocuments(result.data);
        toast.success("Document deleted.");
      }
      setPendingKey(null);
    });
  }

  function onView(document: PatientDocumentItem) {
    setPendingKey(`view:${document.id}`);
    startTransition(async () => {
      const result = await getPatientDocumentSignedUrl(patientId, document.id);
      if (result.error) {
        toast.error(result.error);
      } else if (result.data?.url) {
        window.open(result.data.url, "_blank", "noopener,noreferrer");
      }
      setPendingKey(null);
    });
  }

  return (
    <section className="space-y-3 print:hidden" aria-labelledby="patient-documents-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="patient-documents-heading"
          className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground"
        >
          <FileText className="h-4 w-4" />
          Documents
        </h2>
        <span className="text-xs text-muted-foreground">
          {totalCount} file{totalCount !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
        <div className="divide-y divide-border/30">
          <DocumentSlot
            title="National ID"
            category="national_id"
            document={documents.nationalId}
            inputRef={nationalInputRef}
            isPending={isPending}
            pendingKey={pendingKey}
            onUpload={onUpload}
            onView={onView}
            onDelete={onDelete}
          />
          <DocumentSlot
            title="Insurance"
            category="insurance"
            document={documents.insurance}
            inputRef={insuranceInputRef}
            isPending={isPending}
            pendingKey={pendingKey}
            onUpload={onUpload}
            onView={onView}
            onDelete={onDelete}
          />
        </div>

        <div className="border-t border-border/30 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">Other documents</h3>
              <p className="text-xs text-muted-foreground">
                PDF, JPG, PNG, or WebP. Max 10 MB.
              </p>
            </div>
            <input
              ref={otherInputRef}
              type="file"
              aria-label="Upload other document"
              accept={ACCEPTED_DOCUMENTS}
              className="hidden"
              onChange={(event) => onUpload("other", event)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={isPending}
              onClick={() => inputFor("other").current?.click()}
            >
              {pendingKey === "upload:other" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Add document
            </Button>
          </div>

          {documents.other.length > 0 ? (
            <ul className="divide-y divide-border/30 rounded-lg border border-border/40">
              {documents.other.map((document) => (
                <DocumentRow
                  key={document.id}
                  document={document}
                  isPending={isPending}
                  pendingKey={pendingKey}
                  onView={onView}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          ) : (
            <div className="rounded-lg border border-dashed border-border/60 px-4 py-5 text-center text-sm text-muted-foreground">
              No other documents uploaded yet.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function DocumentSlot({
  title,
  category,
  document,
  inputRef,
  isPending,
  pendingKey,
  onUpload,
  onView,
  onDelete,
}: {
  title: string;
  category: Exclude<DocumentCategory, "other">;
  document: PatientDocumentItem | null;
  inputRef: RefObject<HTMLInputElement | null>;
  isPending: boolean;
  pendingKey: string | null;
  onUpload: (
    category: DocumentCategory,
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
  onView: (document: PatientDocumentItem) => void;
  onDelete: (document: PatientDocumentItem) => void;
}) {
  return (
    <div className="p-4">
      <input
        ref={inputRef}
        type="file"
        aria-label={`Upload ${title} document`}
        accept={ACCEPTED_DOCUMENTS}
        className="hidden"
        onChange={(event) => onUpload(category, event)}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">{title}</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            PDF, JPG, PNG, or WebP. Max 10 MB.
          </p>
        </div>
        {!document && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 sm:self-start"
            disabled={isPending}
            onClick={() => inputRef.current?.click()}
          >
            {pendingKey === `upload:${category}` ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Upload
          </Button>
        )}
      </div>

      {document ? (
        <div className="mt-3 rounded-lg border border-border/40">
          <DocumentRow
            document={document}
            isPending={isPending}
            pendingKey={pendingKey}
            onView={onView}
            onDelete={onDelete}
          />
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-border/60 px-4 py-5 text-center text-sm text-muted-foreground">
          No {title.toLowerCase()} document uploaded yet.
        </div>
      )}
    </div>
  );
}

function DocumentRow({
  document,
  isPending,
  pendingKey,
  onView,
  onDelete,
}: {
  document: PatientDocumentItem;
  isPending: boolean;
  pendingKey: string | null;
  onView: (document: PatientDocumentItem) => void;
  onDelete: (document: PatientDocumentItem) => void;
}) {
  const viewPending = pendingKey === `view:${document.id}`;
  const deletePending = pendingKey === `delete:${document.id}`;

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 truncate text-sm font-medium">
            {document.fileName}
          </p>
          <Badge variant="secondary">{formatMime(document.mimeType)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatBytes(document.sizeBytes)} · Uploaded {formatDate(document.createdAt)}
          {document.uploadedByName ? ` by ${document.uploadedByName}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={isPending}
          onClick={() => onView(document)}
        >
          {viewPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
          View
        </Button>
        <DeleteDocumentDialog
          document={document}
          disabled={isPending}
          pending={deletePending}
          onDelete={onDelete}
        />
      </div>
    </li>
  );
}

function DeleteDocumentDialog({
  document,
  disabled,
  pending,
  onDelete,
}: {
  document: PatientDocumentItem;
  disabled: boolean;
  pending: boolean;
  onDelete: (document: PatientDocumentItem) => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 text-destructive hover:text-destructive"
          disabled={disabled}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete document?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes {document.fileName} from the active patient documents.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onDelete(document)}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-2"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
