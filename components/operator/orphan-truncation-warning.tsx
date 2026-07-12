export function OrphanTruncationWarning({ truncated }: { truncated: boolean }) {
  return truncated ? (
    <p role="alert" className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs dark:border-amber-700 dark:bg-amber-950">
      Warning: the Auth directory scan hit its safety bound — this list may be incomplete.
    </p>
  ) : null;
}
