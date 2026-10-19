// Small formatting helpers shared by the redesigned screens.

// Firestore Timestamps, plain numbers (ms) and ISO strings all appear in the
// data; normalise everything to milliseconds or null.
export function toMillis(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toDate === 'function') {
    try {
      return ts.toDate().getTime();
    } catch {
      return null;
    }
  }
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

export function timeAgo(ts) {
  const ms = toMillis(ts);
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function fmtDateTime(ts) {
  const ms = toMillis(ts);
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '';
  }
}
