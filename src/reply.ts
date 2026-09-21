import { readWords, writeWords, wordsPath } from "./csv.js";
import { applyLevel } from "./srs.js";
import type { Direction, ReviewResult } from "./types.js";

const event = process.env.EVENT_TYPE;
const path = wordsPath(required("CHAT_ID"));

if (event === "flashc-answer") {
  recordAnswer();
} else if (event === "flashc-add") {
  recordWord();
} else {
  throw new Error(`Unknown event type: ${event}`);
}

function recordAnswer(): void {
  const wordId = required("WORD_ID");
  const result = required("RESULT") as ReviewResult;
  const direction = required("DIRECTION") as Direction;
  const today = new Date().toISOString().slice(0, 10);

  const words = readWords(path);
  const word = words.find((candidate) => candidate.id === wordId);
  if (!word) {
    throw new Error(`Unknown word id ${wordId}`);
  }

  const updated = applyLevel(word, direction, result, today);
  writeWords(path, words.map((item) => (item.id === wordId ? updated : item)));

  const level =
    direction === "en_cs" ? updated.level_en_cs : updated.level_cs_en;
  console.log(`Recorded ${result} for "${word.word}" (${direction}), level ${level}.`);
}

function recordWord(): void {
  const word = required("WORD");
  const words = readWords(path);

  if (words.some((item) => item.word.toLowerCase() === word.toLowerCase())) {
    console.log(`"${word}" is already on the list.`);
    return;
  }

  const startLevel = Number(process.env.START_LEVEL) || 0;
  const nextId = String(
    Math.max(0, ...words.map((item) => Number(item.id) || 0)) + 1
  );

  writeWords(path, [
    ...words,
    {
      id: nextId,
      word,
      meaning: process.env.MEANING ?? "",
      example: process.env.EXAMPLE ?? "",
      level_en_cs: startLevel,
      level_cs_en: startLevel,
      practiced_en_cs: "",
      practiced_cs_en: "",
      topic: process.env.TOPIC ?? "",
    },
  ]);

  console.log(`Added "${word}" at level ${startLevel}.`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}
