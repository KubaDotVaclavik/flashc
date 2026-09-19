import { randomUUID } from "node:crypto";
import { readWords, readSessions, writeSessions } from "./csv.js";
import { dueWords } from "./srs.js";
import { generateQuestion } from "./claude.js";
import { sendMessage } from "./telegram.js";

export async function startSession(announceIdle: boolean): Promise<void> {
  const sessions = readSessions();
  const active = sessions.find((session) => session.status === "active");

  if (active) {
    if (announceIdle) {
      await sendMessage(`You still have an open question:\n\n${active.question}`);
    } else {
      console.log("An active session already exists, skipping.");
    }
    return;
  }

  const due = dueWords(readWords());
  if (due.length === 0) {
    if (announceIdle) {
      await sendMessage("Nothing to practise right now. Add a word with /add <word>.");
    } else {
      console.log("Nothing due.");
    }
    return;
  }

  const word = due[Math.floor(Math.random() * due.length)]!;
  const question = await generateQuestion(word);

  writeSessions([
    ...sessions,
    {
      id: randomUUID().slice(0, 8),
      date: new Date().toISOString().slice(0, 10),
      word_id: word.id,
      type: "flashcard",
      status: "active",
      turn: 1,
      question,
    },
  ]);

  await sendMessage(question);
  console.log(`Asked about "${word.word}".`);
}
