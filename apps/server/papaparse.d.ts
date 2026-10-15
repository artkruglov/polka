// The part of papaparse (a dependency without its own types) that
// single-file-view-csv.ts uses.
declare module "papaparse" {
  export interface ParseResult<T> {
    data: T[];
    errors: Array<{ type: string; code: string; message: string; row?: number }>;
    meta: { delimiter: string; linebreak: string; aborted: boolean; truncated: boolean };
  }
  export interface ParseConfig {
    delimiter?: string;
    preview?: number;
    skipEmptyLines?: boolean | "greedy";
  }
  const Papa: { parse<T = string[]>(input: string, config?: ParseConfig): ParseResult<T> };
  export default Papa;
}
