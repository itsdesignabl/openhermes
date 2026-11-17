import YAML from "yaml";

export interface Note<T = Record<string, unknown>> {
  data: T;
  body: string;
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseNote<T = Record<string, unknown>>(text: string): Note<T> {
  const m = FM.exec(text);
  if (!m) return { data: {} as T, body: text };
  const data = (YAML.parse(m[1] ?? "") ?? {}) as T;
  return { data, body: text.slice(m[0].length) };
}

export function formatNote(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(data).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "")}`;
}
