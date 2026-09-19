import type { Word, ReviewResult, WordState } from "./types.js";

const MIN_EASE = 1.3;

function addDays(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextState(successes: number): WordState {
  if (successes >= 6) return "mastered";
  if (successes >= 3) return "familiar";
  return "learning";
}

export function applyReview(word: Word, result: ReviewResult): Word {
  if (result === "bad") {
    return {
      ...word,
      state: "learning",
      interval: 1,
      ease: Math.max(MIN_EASE, word.ease - 0.2),
      failures: word.failures + 1,
      next_review: addDays(1),
    };
  }

  const successes = word.successes + 1;
  const interval = word.interval < 1 ? 1 : Math.round(word.interval * word.ease);

  return {
    ...word,
    state: nextState(successes),
    interval,
    ease: word.ease + 0.1,
    successes,
    next_review: addDays(interval),
  };
}

export function dueWords(words: Word[], today = new Date()): Word[] {
  const todayStr = today.toISOString().slice(0, 10);
  return words.filter(
    (word) =>
      word.state !== "suspended" &&
      (word.next_review === "" || word.next_review <= todayStr)
  );
}
