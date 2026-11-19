import { isAbsolute, relative, resolve, sep } from "node:path"

/**
 * Project-relative POSIX path for `p`, or null when `p` resolves outside
 * the project directory.
 */
export function toProjectRel(directory: string, p: string): string | null {
  const abs = isAbsolute(p) ? resolve(p) : resolve(directory, p)
  const rel = relative(resolve(directory), abs)
  if (rel === "") return ""
  if (rel.startsWith("..") || isAbsolute(rel)) return null
  return rel.split(sep).join("/")
}

/** The topic slug a project-relative path belongs to, compared by segment. */
export function topicOfPath(rel: string, topicsDir: string): string | null {
  const segs = rel.split("/").filter(Boolean)
  const base = topicsDir.split("/").filter(Boolean)
  if (segs.length <= base.length) return null
  for (let i = 0; i < base.length; i++) if (segs[i] !== base[i]) return null
  const slug = segs[base.length]
  return slug && slug !== "_template" ? slug : null
}

/** The path inside the topic folder (`findings/x.md`), or null. */
export function pathWithinTopic(rel: string, topicsDir: string, slug: string): string | null {
  const prefix = `${topicsDir.replace(/\/+$/, "")}/${slug}/`
  return rel.startsWith(prefix) ? rel.slice(prefix.length) : null
}

/** Whether `rel` is under one of the allowlisted prefixes (segment-aware). */
export function underAllowlist(rel: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => {
    const e = entry.replace(/\/+$/, "")
    return rel === e || rel.startsWith(`${e}/`)
  })
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/
