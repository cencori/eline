/**
 * Model helper functions. Each returns the slug the runner passes to its
 * upstream (currently the Cencori sessions API). Kept as passthroughs so
 * the ergonomic surface can stabilize while direct-provider routing lands
 * later without breaking existing agent files.
 *
 *   import { cencori } from "arcie/models";
 *
 *   export default defineAgent({
 *     model: cencori("gemini-3.1-pro"),
 *     name: "my-agent",
 *   });
 */

/**
 * Selects a model served through Cencori's AI Gateway. Accepts either a
 * bare slug (`"gemini-3.1-pro"`) or a provider-qualified one
 * (`"google/gemini-3.1-pro"`) — Cencori resolves both.
 */
export function cencori(slug: string): string {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new TypeError("cencori(slug): slug must be a non-empty string");
  }
  return slug;
}
