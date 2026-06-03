/**
 * Shared markdown cleanup for Sage-tagged payloads (vows, receipt brand lists, etc.).
 */

export function stripMarkdownFromVowText(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n').trim();
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]+)`/g, '$1');
  for (let i = 0; i < 6; i++) {
    const next = s
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, '$1$2$3');
  s = s.replace(/(^|[^_])_([^_\n\s][^_]*[^_\n\s])_([^_]|$)/g, '$1$2$3');
  s = s.replace(/[`_*]/g, '');
  s = s.replace(/<\/?[a-z][a-z0-9]*[^>]*>/gi, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
