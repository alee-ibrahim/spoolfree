export function timeAgo(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "never";
  const t = typeof d === "string" ? new Date(d) : d;
  const s = Math.round((now.getTime() - t.getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function shortDn(dn: string): string {
  return dn
    .split(/,(?=(?:OU|CN|DC)=)/i)
    .filter((p) => !/^DC=/i.test(p))
    .map((p) => p.replace(/^(OU|CN)=/i, ""))
    .reverse()
    .join(" / ");
}

/** Short name of an OU for a badge: its own name ("Finance"), not the whole path. */
export function ouShortName(dn: string): string {
  const first = dn.split(/,(?=(?:OU|CN|DC)=)/i)[0] ?? dn;
  return first.replace(/^(OU|CN|DC)=/i, "").replace(/\\(.)/g, "$1") || dn;
}
