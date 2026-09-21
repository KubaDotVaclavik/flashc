import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import type { Word } from "./types.js";

const WORD_COLUMNS = [
  "id", "word", "meaning", "example",
  "level_en_cs", "level_cs_en",
  "practiced_en_cs", "practiced_cs_en",
  "topic",
] as const;

export function wordsPath(chatId: string): string {
  // Group chat ids are negative, and a file starting with "-" is read as a flag
  // by most shell tools, so the name carries a prefix.
  return `data/chat_${chatId}.csv`;
}

export function readWords(path: string): Word[] {
  if (!existsSync(path)) return [];

  const rows: Record<string, string>[] = parse(readFileSync(path, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return rows.map((row) => ({
    id: row.id ?? "",
    word: row.word ?? "",
    meaning: row.meaning ?? "",
    example: row.example ?? "",
    level_en_cs: Number(row.level_en_cs) || 0,
    level_cs_en: Number(row.level_cs_en) || 0,
    practiced_en_cs: row.practiced_en_cs ?? "",
    practiced_cs_en: row.practiced_cs_en ?? "",
    topic: row.topic ?? "",
  }));
}

export function writeWords(path: string, words: Word[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    stringify(words, { header: true, columns: [...WORD_COLUMNS] })
  );
}
