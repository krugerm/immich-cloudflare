export function parseAdminNames(text: string): Map<string, string>;
export function parseCountryInfo(text: string): { code2: string; code3: string; name: string }[];
export function cellOf(lat: number): number;
export interface CityRow {
  id: number; name: string; lat: number; lon: number; cc: string; admin1: string | null; admin2: string | null; cell: number;
}
export function parseCities(text: string, admin1: Map<string, string>, admin2: Map<string, string>): Generator<CityRow>;
export function sqlValue(v: unknown): string;
export function insertStatements(table: string, columns: string[], rows: Iterable<Record<string, unknown>>, maxBytes?: number): string[];
export function groupStatements(statements: string[], maxBytes?: number): string[][];
export const byteLength: (s: string) => number;
export const PREPARE_SQL: string[];
export const SWAP_SQL: string[];
