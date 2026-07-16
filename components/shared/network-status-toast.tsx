"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

const TOAST_ID = "network-status";

export function NetworkStatusToast() {
  const t = useTranslations("shared");

  useEffect(() => {
    let isOnline = navigator.onLine;

    const handleOffline = () => {
      if (!isOnline) return;
      isOnline = false;
      toast.warning(t("youAreOffline"), {
        id: TOAST_ID,
        duration: Infinity,
      });
    };

    const handleOnline = () => {
      if (isOnline) return;
      isOnline = true;
      toast.success(t("backOnline"), { id: TOAST_ID, duration: 4000 });
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [t]);

  return null;
}
