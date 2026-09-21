export type WordState = "new" | "learning" | "familiar" | "mastered" | "suspended";

export type Word = {
  id: string;
  word: string;
  meaning: string;
  example: string;
  state: WordState;
  next_review: string;
  interval: number;
  ease: number;
  successes: number;
  failures: number;
  tags: string;
  notes: string;
};

export type ReviewResult = "good" | "bad";

/** Payloads the Worker sends to GitHub, and the Action reads back. */
export type AnswerPayload = {
  word_id: string;
  answer: string;
  result: ReviewResult;
  score: number;
};

export type AddPayload = {
  word: string;
  meaning: string;
  example: string;
};
