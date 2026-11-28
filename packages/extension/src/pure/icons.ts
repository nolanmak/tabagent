// Small stroke icons (#156) as inline SVG strings: 16px grid, currentColor, decorative (aria-hidden).
// TabAgent's own; no icon font or remote asset (MV3 CSP).

const PATHS = {
  terminal: '<path d="M3 4.5 6.5 8 3 11.5M8.5 12H13"/>',
  file: '<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z"/><path d="M9 2v4h4"/>',
  pencil: '<path d="m10.5 3 2.5 2.5L6 12.5 3 13l.5-3z"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
  globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.7 2.4 3.5 2.4 5.5S9.6 11.8 8 13.5C6.4 11.8 5.6 10 5.6 8S6.4 4.2 8 2.5z"/>',
  spark: '<path d="M8 2.5 9.3 6.7 13.5 8l-4.2 1.3L8 13.5 6.7 9.3 2.5 8l4.2-1.3z"/>',
  list: '<path d="M6.5 4.5H13M6.5 8H13M6.5 11.5H13M3.5 4.5h0M3.5 8h0M3.5 11.5h0"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
  wrench: '<path d="M10 2.8a3 3 0 0 0-3.4 3.9L2.8 10.5l2.7 2.7 3.8-3.8A3 3 0 0 0 13.2 6l-1.8 1.8-2-.6-.6-2z"/>',
  reply: '<path d="M3.5 3v4.5A2.5 2.5 0 0 0 6 10h7M10 7l3 3-3 3"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): string {
  return `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}

/** The icon for an agent tool call, by the tool's name (Claude Code and Codex names). */
export function toolIcon(name: string): IconName {
  const n = name.toLowerCase();
  if (n === "interrupted") return "stop";
  if (n === "result") return "reply";
  if (/bash|shell|exec|command|terminal/.test(n)) return "terminal";
  if (/edit|write|patch|notebook/.test(n)) return "pencil";
  if (/grep|glob|search|find|^ls$/.test(n)) return "search";
  if (/web|fetch|url|browser|tabagent/.test(n)) return "globe";
  if (/read|view|^cat$/.test(n)) return "file";
  if (/todo|plan/.test(n)) return "list";
  if (/task|agent/.test(n)) return "spark";
  return "wrench";
}
