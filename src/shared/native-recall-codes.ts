/** Native AM address-code interpretation shared by plot recall and continuation. */
export function normalizeAmCode_ACU(value: unknown): string | null {
  const code = String(value ?? '').trim().toUpperCase();
  return /^AM\d+$/i.test(code) ? code : null;
}
export function extractNativeRecallCodes_ACU(text: string): string[] {
  return [...new Set((String(text || '').match(/AM\d+/gi) || []).map(normalizeAmCode_ACU).filter((code): code is string => code !== null))];
}
