import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import type { Word } from "./types.js";

const WORDS_PATH = "data/words.csv";

const WORD_COLUMNS = [
  "id", "word", "meaning", "example",
  "level_en_cs", "level_cs_en",
  "practiced_en_cs", "practiced_cs_en",
  "tags",
] as const;

export function readWords(): Word[] {
  if (!existsSync(WORDS_PATH)) return [];

  const rows: Record<string, string>[] = parse(readFileSync(WORDS_PATH, "utf8"), {
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
    tags: row.tags ?? "",
  }));
}

export function writeWords(words: Word[]): void {
  mkdirSync(dirname(WORDS_PATH), { recursive: true });
  writeFileSync(
    WORDS_PATH,
    stringify(words, { header: true, columns: [...WORD_COLUMNS] })
  );
}
