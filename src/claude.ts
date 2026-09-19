import Anthropic from "@anthropic-ai/sdk";
import type { Word, ReviewResult } from "./types.js";

const MODEL = "claude-opus-5";

const STUBBED = !process.env.ANTHROPIC_API_KEY;
if (STUBBED) {
  console.warn("⚠️  ANTHROPIC_API_KEY not set — using stubbed Claude responses.");
}

let cached: Anthropic | undefined;
function client(): Anthropic {
  return (cached ??= new Anthropic());
}

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

export async function generateQuestion(word: Word): Promise<string> {
  if (STUBBED) {
    return `[stub] What does "${word.word}" mean in Czech?`;
  }

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1000,
    output_config: { effort: "low" },
    system:
      "You are an English tutor for a Czech learner. Ask one short flashcard question " +
      "about the target word. Ask for the Czech meaning, or for the word matching a " +
      "definition. Output only the question, no preamble.",
    messages: [
      {
        role: "user",
        content: `Target word: ${word.word}\nMeaning: ${word.meaning}`,
      },
    ],
  });

  return textOf(response);
}

export type Evaluation = {
  result: ReviewResult;
  score: number;
  feedback: string;
};

export async function evaluateAnswer(
  word: Word,
  question: string,
  answer: string
): Promise<Evaluation> {
  if (STUBBED) {
    const normalize = (value: string) =>
      value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
    const hit = normalize(word.meaning)
      .split(/[;,]/)
      .some((variant) => normalize(answer).includes(variant.trim()));
    return hit
      ? { result: "good", score: 0.9, feedback: `[stub] Correct — ${word.meaning}.` }
      : { result: "bad", score: 0.2, feedback: `[stub] No, it means ${word.meaning}.` };
  }

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            result: { type: "string", enum: ["good", "bad"] },
            score: { type: "number", minimum: 0, maximum: 1 },
            feedback: {
              type: "string",
              description: "One or two short sentences for the learner.",
            },
          },
          required: ["result", "score", "feedback"],
          additionalProperties: false,
        },
      },
    },
    system:
      "You grade a Czech learner's flashcard answer about an English word. " +
      "Accept synonyms and minor typos, in Czech or English. " +
      "Mark 'bad' only if the meaning is wrong or missing. " +
      "Write the feedback in English, and confirm the correct meaning briefly.",
    messages: [
      {
        role: "user",
        content: [
          `Word: ${word.word}`,
          `Correct meaning: ${word.meaning}`,
          `Question asked: ${question}`,
          `Learner's answer: ${answer}`,
        ].join("\n"),
      },
    ],
  });

  return JSON.parse(textOf(response)) as Evaluation;
}

export type WordDetails = {
  meaning: string;
  example: string;
};

export async function lookupWord(word: string): Promise<WordDetails> {
  if (STUBBED) {
    return {
      meaning: `[stub] meaning of ${word}`,
      example: `[stub] This is an example with ${word}.`,
    };
  }

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1000,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: {
            meaning: {
              type: "string",
              description: "Czech translation, a few words at most.",
            },
            example: {
              type: "string",
              description: "One short English sentence using the word.",
            },
          },
          required: ["meaning", "example"],
          additionalProperties: false,
        },
      },
    },
    system:
      "You help a Czech learner build an English vocabulary list. " +
      "Give the Czech meaning and one natural example sentence.",
    messages: [{ role: "user", content: `Word: ${word}` }],
  });

  return JSON.parse(textOf(response)) as WordDetails;
}
