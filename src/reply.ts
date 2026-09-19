import {
  readWords,
  writeWords,
  readSessions,
  writeSessions,
  appendReview,
} from "./csv.js";
import { applyReview } from "./srs.js";
import { evaluateAnswer, lookupWord } from "./claude.js";
import { sendMessage } from "./telegram.js";
import { startSession } from "./session.js";

const text = (process.env.MESSAGE_TEXT ?? "").trim();
if (!text) {
  console.log("Empty message, nothing to do.");
  process.exit(0);
}

if (text === "/add" || text.startsWith("/add ")) {
  await addWord(text.slice(4).trim());
} else if (text === "/session") {
  await startSession(true);
} else {
  await answerSession(text);
}

async function addWord(input: string): Promise<void> {
  if (!input) {
    await sendMessage("Usage: /add <word>");
    return;
  }

  const words = readWords();
  if (words.some((word) => word.word.toLowerCase() === input.toLowerCase())) {
    await sendMessage(`"${input}" is already on your list.`);
    return;
  }

  const details = await lookupWord(input);
  const nextId = String(
    Math.max(0, ...words.map((word) => Number(word.id) || 0)) + 1
  );

  writeWords([
    ...words,
    {
      id: nextId,
      word: input,
      meaning: details.meaning,
      example: details.example,
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

  await sendMessage(
    `➕ ${input} — ${details.meaning}\n\n${details.example}`
  );
}

async function answerSession(answer: string): Promise<void> {
  const sessions = readSessions();
  const active = sessions.find((session) => session.status === "active");
  if (!active) {
    await sendMessage(
      "No practice session is running. Start one with /session, or add a word with /add <word>."
    );
    return;
  }

  const words = readWords();
  const word = words.find((candidate) => candidate.id === active.word_id);
  if (!word) {
    throw new Error(`Session ${active.id} references unknown word ${active.word_id}`);
  }

  const evaluation = await evaluateAnswer(word, active.question, answer);

  appendReview({
    timestamp: new Date().toISOString(),
    word_id: word.id,
    type: "flashcard",
    direction: "EN->CS",
    result: evaluation.result,
    score: evaluation.score,
    notes: answer,
  });

  const updated = applyReview(word, evaluation.result);
  writeWords(words.map((item) => (item.id === word.id ? updated : item)));
  writeSessions(
    sessions.map((session) =>
      session.id === active.id ? { ...session, status: "completed" as const } : session
    )
  );

  const mark = evaluation.result === "good" ? "✅" : "❌";
  await sendMessage(
    `${mark} ${evaluation.feedback}\n\nNext review: ${updated.next_review}`
  );
}
