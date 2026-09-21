import { readWords, writeWords, appendReview } from "./csv.js";
import { applyReview } from "./srs.js";
import type { ReviewResult } from "./types.js";

const event = process.env.EVENT_TYPE;

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

  const words = readWords();
  const word = words.find((candidate) => candidate.id === wordId);
  if (!word) {
    throw new Error(`Unknown word id ${wordId}`);
  }

  appendReview({
    timestamp: new Date().toISOString(),
    word_id: wordId,
    type: "flashcard",
    direction: "EN->CS",
    result,
    score: Number(process.env.SCORE) || 0,
    notes: process.env.ANSWER ?? "",
  });

  const updated = applyReview(word, result);
  writeWords(words.map((item) => (item.id === wordId ? updated : item)));

  console.log(`Recorded ${result} for "${word.word}", next ${updated.next_review}.`);
}

function recordWord(): void {
  const word = required("WORD");
  const words = readWords();

  if (words.some((item) => item.word.toLowerCase() === word.toLowerCase())) {
    console.log(`"${word}" is already on the list.`);
    return;
  }

  const nextId = String(
    Math.max(0, ...words.map((item) => Number(item.id) || 0)) + 1
  );

  writeWords([
    ...words,
    {
      id: nextId,
      word,
      meaning: process.env.MEANING ?? "",
      example: process.env.EXAMPLE ?? "",
      state: "new",
      next_review: "",
      interval: 0,
      ease: 2.5,
      successes: 0,
      failures: 0,
      tags: "",
      notes: "",
    },
  ]);

  console.log(`Added "${word}".`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}
