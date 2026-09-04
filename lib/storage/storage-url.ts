const PUBLIC_OBJECT_PREFIX = "/storage/v1/object/public/";

/**
 * Re-point a stored public Supabase Storage URL at the project this process is
 * configured against.
 *
 * A stored asset URL is `origin` + `/storage/v1/object/public/<bucket>/<path>`.
 * Only the bucket/path half is durable data — the origin is a property of the
 * Supabase project the row happened to be written against. When a database is
 * copied between projects (hosted → local dump/restore for testing), every
 * stored URL keeps the *source* project's origin even though the object also
 * exists in the copy, so the app would read its own assets out of the source
 * project. Regenerating the origin is equivalent to calling
 * `storage.from(bucket).getPublicUrl(path)` again today, without rewriting any
 * row.
 *
 * In every environment where the row was written against the configured
 * project — i.e. all deployed environments — this is the identity function.
 *
 * Signed (`/object/sign/`) and authenticated URLs are returned untouched: their
 * token is issued by one specific project and does not survive a move, so they
 * must be re-issued by whichever code created them rather than patched here.
 */
export function toConfiguredStorageOrigin(
  url: string | null | undefined,
): string | null {
  if (!url) return null;

  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configured) return url;

  let source: URL;
  let target: URL;
  try {
    source = new URL(url);
    target = new URL(configured);
  } catch {
    return url;
  }

  if (!source.pathname.startsWith(PUBLIC_OBJECT_PREFIX)) return url;
  if (source.origin === target.origin) return url;

  return new URL(
    `${source.pathname}${source.search}${source.hash}`,
    target.origin,
  ).toString();
}
