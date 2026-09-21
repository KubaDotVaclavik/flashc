import type { Word, Direction, ReviewResult } from "./types.js";

export const MAX_LEVEL = 8;

/**
 * How far a wrong answer knocks a word back. Learning (0-5) costs exactly one
 * correct answer to repair; the higher bands cost more, so a word forgotten
 * after weeks of silence drops back into daily practice rather than being
 * re-confirmed by a single lucky answer.
 */
function penalty(level: number): number {
  if (level >= MAX_LEVEL) return 3;
  if (level >= 6) return 2;
  return 1;
}

export function applyLevel(
  word: Word,
  direction: Direction,
  result: ReviewResult,
  today: string
): Word {
  const level = direction === "en_cs" ? word.level_en_cs : word.level_cs_en;

  const next =
    result === "good"
      ? Math.min(MAX_LEVEL, level + 1)
      : Math.max(0, level - penalty(level));

  return direction === "en_cs"
    ? { ...word, level_en_cs: next, practiced_en_cs: today }
    : { ...word, level_cs_en: next, practiced_cs_en: today };
}
