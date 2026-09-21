export type { Word, WordState, ReviewResult } from "../shared/types.js";

import type { ReviewResult } from "../shared/types.js";

export type Review = {
  timestamp: string;
  word_id: string;
  type: string;
  direction: string;
  result: ReviewResult;
  score: number;
  notes: string;
};
