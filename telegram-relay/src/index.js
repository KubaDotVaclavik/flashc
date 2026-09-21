import { parseCsv } from "./csv.js";

const ACTIVE_SESSION_KEY = "active_session";

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    // Telegram sends this header when a secret_token was set on the webhook.
    // Rejects any request that doesn't know our secret (e.g. random internet scans).
    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
      env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const message = update.message;
    if (!message || typeof message.text !== "string") {
      return new Response("ignored", { status: 200 });
    }

    // Telegram retries a webhook it considers failed, which would double-grade
    // an answer. Returning 200 immediately and working in the background avoids that.
    ctx.waitUntil(guard(handleMessage(message.text.trim(), env), env));
    return new Response("ok", { status: 200 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(guard(startSession(false, env), env));
  },
};

async function guard(work, env) {
  try {
    await work;
  } catch (error) {
    console.error(error);
    await sendMessage("Something went wrong. Please try again.", env).catch(() => {});
  }
}

async function handleMessage(text, env) {
  if (text === "/add" || text.startsWith("/add ")) {
    await addWord(text.slice(4).trim(), env);
  } else if (text === "/session") {
    await startSession(true, env);
  } else {
    await gradeAnswer(text, env);
  }
}

async function startSession(announceIdle, env) {
  const active = await env.SESSIONS.get(ACTIVE_SESSION_KEY, "json");
  if (active) {
    if (announceIdle) {
      await sendMessage(`You still have an open question:\n\n${active.question}`, env);
    }
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const due = (await readWords(env)).filter(
    (word) =>
      word.state !== "suspended" &&
      (!word.next_review || word.next_review <= today)
  );

  if (due.length === 0) {
    if (announceIdle) {
      await sendMessage("Nothing to practise right now. Add a word with /add <word>.", env);
    }
    return;
  }

  const word = due[Math.floor(Math.random() * due.length)];
  const question = await askQuestion(word, env);

  await env.SESSIONS.put(
    ACTIVE_SESSION_KEY,
    JSON.stringify({
      word_id: word.id,
      word: word.word,
      meaning: word.meaning,
      question,
    })
  );

  await sendMessage(question, env);
}

async function gradeAnswer(answer, env) {
  const session = await env.SESSIONS.get(ACTIVE_SESSION_KEY, "json");
  if (!session) {
    await sendMessage(
      "No practice session is running. Start one with /session, or add a word with /add <word>.",
      env
    );
    return;
  }

  const evaluation = await evaluateAnswer(session, answer, env);

  // Record the result before clearing the session: if the dispatch fails, the
  // session stays open and the answer can be retried rather than silently lost.
  await dispatch(
    "flashc-answer",
    {
      word_id: session.word_id,
      answer,
      result: evaluation.result,
      score: evaluation.score,
    },
    env
  );
  await env.SESSIONS.delete(ACTIVE_SESSION_KEY);

  const mark = evaluation.result === "good" ? "✅" : "❌";
  await sendMessage(`${mark} ${evaluation.feedback}`, env);
}

async function addWord(word, env) {
  if (!word) {
    await sendMessage("Usage: /add <word>", env);
    return;
  }

  const words = await readWords(env);
  if (words.some((item) => item.word.toLowerCase() === word.toLowerCase())) {
    await sendMessage(`"${word}" is already on your list.`, env);
    return;
  }

  const details = await lookupWord(word, env);
  await dispatch(
    "flashc-add",
    { word, meaning: details.meaning, example: details.example },
    env
  );
  await sendMessage(`➕ ${word} — ${details.meaning}\n\n${details.example}`, env);
}

async function readWords(env) {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/data/words.csv`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "flashc-telegram-relay",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Reading words.csv failed: ${response.status} ${await response.text()}`);
  }

  return parseCsv(await response.text());
}

async function dispatch(eventType, payload, env) {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "flashc-telegram-relay",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload }),
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub dispatch failed: ${response.status} ${await response.text()}`);
  }
}

async function sendMessage(text, env) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

async function callClaude({ system, user, schema, stub }, env) {
  if (!env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_API_KEY not set — using stubbed Claude response.");
    return stub();
  }

  const body = {
    model: "claude-opus-5",
    max_tokens: 1000,
    output_config: { effort: "low" },
    system,
    messages: [{ role: "user", content: user }],
  };
  if (schema) {
    body.output_config.format = { type: "json_schema", schema };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Claude request failed: ${response.status} ${await response.text()}`);
  }

  const text = (await response.json()).content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return schema ? JSON.parse(text) : text;
}

function askQuestion(word, env) {
  return callClaude(
    {
      system:
        "You are an English tutor for a Czech learner. Ask one short flashcard question " +
        "about the target word. Ask for the Czech meaning, or for the word matching a " +
        "definition. Output only the question, no preamble.",
      user: `Target word: ${word.word}\nMeaning: ${word.meaning}`,
      stub: () => `[stub] What does "${word.word}" mean in Czech?`,
    },
    env
  );
}

function evaluateAnswer(session, answer, env) {
  return callClaude(
    {
      system:
        "You grade a Czech learner's flashcard answer about an English word. " +
        "Accept synonyms and minor typos, in Czech or English. " +
        "Mark 'bad' only if the meaning is wrong or missing. " +
        "Write the feedback in English, and confirm the correct meaning briefly.",
      schema: {
        type: "object",
        properties: {
          result: { type: "string", enum: ["good", "bad"] },
          score: { type: "number", minimum: 0, maximum: 1 },
          feedback: { type: "string" },
        },
        required: ["result", "score", "feedback"],
        additionalProperties: false,
      },
      user: [
        `Word: ${session.word}`,
        `Correct meaning: ${session.meaning}`,
        `Question asked: ${session.question}`,
        `Learner's answer: ${answer}`,
      ].join("\n"),
      stub: () => {
        const strip = (value) =>
          value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
        const hit = strip(session.meaning)
          .split(/[;,]/)
          .some((variant) => strip(answer).includes(variant.trim()));
        return hit
          ? { result: "good", score: 0.9, feedback: `[stub] Correct — ${session.meaning}.` }
          : { result: "bad", score: 0.2, feedback: `[stub] No, it means ${session.meaning}.` };
      },
    },
    env
  );
}

function lookupWord(word, env) {
  return callClaude(
    {
      system:
        "You help a Czech learner build an English vocabulary list. " +
        "Give the Czech meaning and one natural example sentence.",
      schema: {
        type: "object",
        properties: {
          meaning: { type: "string" },
          example: { type: "string" },
        },
        required: ["meaning", "example"],
        additionalProperties: false,
      },
      user: `Word: ${word}`,
      stub: () => ({
        meaning: `[stub] meaning of ${word}`,
        example: `[stub] This is an example with ${word}.`,
      }),
    },
    env
  );
}
