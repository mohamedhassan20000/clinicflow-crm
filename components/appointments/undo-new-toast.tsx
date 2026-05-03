"use client";

import { useEffect, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { deleteNewAppointment } from "@/actions/appointments";

/**
 * Rendered on the appointments page when ?undo=<id> is present in the URL.
 * Shows a 10-second Sonner toast with an "Undo" action that cancels the booking.
 * Cleans the URL after showing the toast so it doesn't fire again on navigation.
 */
export function UndoNewToast() {
  const params = useSearchParams();
  const router = useRouter();
  const firedRef = useRef(false);
  const newId = params.get("undo");

  useEffect(() => {
    if (!newId || firedRef.current) return;
    firedRef.current = true;

    // Clean the URL immediately so navigating back doesn't re-trigger
    router.replace("/appointments", { scroll: false });

    toast.success("Appointment booked.", {
      duration: 10000,
      action: {
        label: "Undo",
        onClick: async () => {
          const result = await deleteNewAppointment(newId);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("Booking cancelled.");
          }
        },
      },
    });
  }, [newId, router]);

  return null;
}
