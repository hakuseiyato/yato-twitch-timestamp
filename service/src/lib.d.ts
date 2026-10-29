// panel/js/lib.js（拡張・パネルと共有の純関数）のうち Worker が使う分の型
// Types for the part of panel/js/lib.js (pure functions shared with the extension and panel) the Worker uses
declare module '*/panel/js/lib.js' {
  interface StampRecord {
    id?: string;
    offset_sec?: number | string;
    created_at?: string;
    updated_at?: string;
    deleted?: boolean;
    [key: string]: unknown;
  }

  interface NormalizedRecord extends StampRecord {
    id: string;
    offset_sec: number;
    updated_at: string;
    deleted: boolean;
  }

  const TSLib: {
    // offset_sec を 3 桁に丸め、ID を補い、updated_at と deleted を揃えた複製を返す
    // Returns a copy with offset_sec rounded to 3 places, id filled in, updated_at and deleted normalized
    normalizeRecord(record: StampRecord): NormalizedRecord;
    // 'y' + 7 桁 hex / 'y' + 7 hex digits
    newId(): string;
    isValidId(value: unknown): boolean;
    repairId(raw: unknown): string | null;
    round3(value: unknown): number;
    // hh:mm:ss
    formatTimecode(sec: unknown): string;
    // Twitch のログイン名として正しければ小文字化して返す / Lowercased login if valid, else null
    validLogin(value: unknown): string | null;
  };
  export default TSLib;
}
