/** Follow the server's log without writing to it: pull and live only. The same options as connect(). */
export function follow(options?: { url?: string; interval?: number; live?: boolean; scope?: Record<string, true | string | string[]> | null }): { pull(): Promise<void>; stop(): void };
