export const ROUTES: 'routes';
export const APP: 'app';

export class RouteError extends Error {}

/** The path a component's place in `routes/` gives it (`routes/farms/[id]` → `/farms/:id`), or null. */
export function folderPattern(name: string, kind?: 'page' | 'layout'): string | null;
/** A pathname pattern's named parameters, in order. */
export function patternParams(pattern: string): string[];

export interface TableEntry {
  name: string;
  file?: string;
  props?: string[];
  slots?: string[];
  route: null | { kind: 'page' | 'layout'; pattern: string | null; params?: string[]; root?: boolean; load?: boolean; reads?: string[] | null };
}

export interface TablePage { name: string; file: string; pattern: string; params: string[]; load: boolean; root: boolean; layouts?: string[]; around?: string[] }

export function buildTable(entries: TableEntry[]): { pages: TablePage[]; layouts: TablePage[] };
/** The layouts around a page's pattern, outermost first, from the innermost `root` one. */
export function layoutsFor<L extends { pattern: string; root: boolean }>(pattern: string, layouts: L[]): L[];
/** Every layout over a pattern, `root` ones or not. */
export function layoutsAround<L extends { pattern: string; root: boolean }>(pattern: string, layouts: L[]): L[];
/** A list of layouts from its innermost `root` one. */
export function fromRoot<L extends { root: boolean }>(around: L[]): L[];
export function matcher(pages: TablePage[], URLPattern: unknown): (pathname: string) => { page: TablePage; params: Record<string, string> } | null;
