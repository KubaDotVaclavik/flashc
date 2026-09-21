import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import type { Word, Review } from "./types.js";

const WORDS_PATH = "data/words.csv";
const REVIEWS_PATH = "data/reviews.csv";

const WORD_COLUMNS = [
  "id", "word", "meaning", "example", "state", "next_review",
  "interval", "ease", "successes", "failures", "tags", "notes",
] as const;

const REVIEW_COLUMNS = [
  "timestamp", "word_id", "type", "direction", "result", "score", "notes",
] as const;

function readRows(path: string): Record<string, string>[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}

function writeRows(path: string, columns: readonly string[], rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(rows, { header: true, columns: [...columns] }));
}

export function readWords(): Word[] {
  return readRows(WORDS_PATH).map((row) => ({
    id: row.id ?? "",
    word: row.word ?? "",
    meaning: row.meaning ?? "",
    example: row.example ?? "",
    state: (row.state || "new") as Word["state"],
    next_review: row.next_review ?? "",
    interval: Number(row.interval) || 0,
    ease: Number(row.ease) || 2.5,
    successes: Number(row.successes) || 0,
    failures: Number(row.failures) || 0,
    tags: row.tags ?? "",
    notes: row.notes ?? "",
  }));
}

export function writeWords(words: Word[]): void {
  writeRows(WORDS_PATH, WORD_COLUMNS, words);
}

export function readReviews(): Review[] {
  return readRows(REVIEWS_PATH).map((row) => ({
    timestamp: row.timestamp ?? "",
    word_id: row.word_id ?? "",
    type: row.type ?? "flashcard",
    direction: row.direction ?? "",
    result: (row.result || "bad") as Review["result"],
    score: Number(row.score) || 0,
    notes: row.notes ?? "",
  }));
}

export function appendReview(review: Review): void {
  writeRows(REVIEWS_PATH, REVIEW_COLUMNS, [...readReviews(), review]);
}
