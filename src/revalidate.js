/**
 * Cache tags understood by the blog's /api/revalidate route handler.
 * Keep in sync with the blog's lib/contracts/revalidation.ts.
 */
export const POSTS_TAG = "posts";
export const postTag = (slug) => `post:${slug}`;

/**
 * Creates a function that tells the blog which cache tags to revalidate.
 * It never throws: a failed webhook is logged and must not fail the write
 * that triggered it, because the post is already saved on disk.
 */
export function createRevalidationNotifier({ url, secret, timeoutMs = 5000, logger = console } = {}) {
  if (!url || !secret) {
    logger.warn("Revalidation webhook disabled: set REVALIDATE_URL and REVALIDATE_SECRET to refresh the blog after writes.");
    return async () => false;
  }

  return async function notifyRevalidation(tags) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-revalidate-secret": secret },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        logger.error(`Revalidation webhook responded with ${response.status} for tags: ${tags.join(", ")}`);
        return false;
      }
      return true;
    } catch (error) {
      logger.error(`Revalidation webhook failed for tags: ${tags.join(", ")}`, error);
      return false;
    }
  };
}
