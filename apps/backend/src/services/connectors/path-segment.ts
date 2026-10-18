/**
 * A provider id or key as one safe segment of a mirror path. A real provider
 * id is already safe, so it stays the same. Each other character becomes
 * "-", and a leading "." becomes "-". Thus the segment cannot be "." or "..",
 * cannot add a folder, and cannot make a hidden file.
 */
export function connectorPathSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._~-]/g, "-").replace(/^\./, "-") || "-"
}
