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

export type Review = {
  timestamp: string;
  word_id: string;
  type: string;
  direction: string;
  result: ReviewResult;
  score: number;
  notes: string;
};

export type ReviewResult = "good" | "bad";

export type SessionStatus = "active" | "completed";

export type Session = {
  id: string;
  date: string;
  word_id: string;
  type: string;
  status: SessionStatus;
  turn: number;
  question: string;
};
