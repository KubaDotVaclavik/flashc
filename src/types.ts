export type Direction = "en_cs" | "cs_en";

export type ReviewResult = "good" | "bad";

export type Word = {
  id: string;
  word: string;
  meaning: string;
  example: string;
  level_en_cs: number;
  level_cs_en: number;
  practiced_en_cs: string;
  practiced_cs_en: string;
  topic: string;
};
