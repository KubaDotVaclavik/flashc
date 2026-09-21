import { parseCsv } from "./csv.js";

const sessionKey = (chatId: string) => `active_session:${chatId}`;
const idleKey = (chatId: string) => `idle_notice_day:${chatId}`;
const wordsPath = (chatId: string) => `data/chat_${chatId}.csv`;

const MAX_LEVEL = 8;
const LEARNING_MAX = 5;

type Direction = "en_cs" | "cs_en";

/** Only the columns of words.csv this Worker reads; the repo owns the full row. */
type Word = {
  id: string;
  word: string;
  meaning: string;
  example: string;
  level_en_cs: number;
  level_cs_en: number;
  practiced_en_cs: string;
  practiced_cs_en: string;
};

type Candidate = {
  word: Word;
  direction: Direction;
  level: number;
  practiced: string;
};

type AnswerPayload = {
  chat_id: string;
  word_id: string;
  answer: string;
  result: "good" | "bad";
  direction: Direction;
};

type AddPayload = {
  chat_id: string;
  word: string;
  meaning: string;
  example: string;
  start_level: number;
  topic: string;
};

/** A subject area that steers how Claude explains a word. Configured in TOPICS. */
type Topic = {
  key: string;
  label: string;
  instruction: string;
};

type Env = {
  SESSIONS: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_IDS: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  TOPICS?: string;
  START_LEVEL?: string;
  WORDS_PER_SESSION?: string;
  LEARNING_POOL?: string;
  REVIEW_POOL?: string;
  COOLDOWN_6?: string;
  COOLDOWN_7?: string;
  COOLDOWN_8?: string;
  LEARNING_WARN?: string;
  REVIEW_WARN?: string;
};

type Question = {
  word_id: string;
  word: string;
  meaning: string;
  direction: Direction;
  question: string;
};

type ActiveSession = {
  questions: Question[];
  current: number;
};

type Evaluation = {
  result: AnswerPayload["result"];
  score: number;
  feedback: string;
};

type WordDetails = {
  /** Empty when the input is not a word Claude recognises in either language. */
  word: string;
  meaning: string;
  example: string;
};

const FALLBACK_TOPIC: Topic = {
  key: "general",
  label: "General",
  instruction:
    "Explain the everyday meaning and write a natural example sentence from ordinary life.",
};

/**
 * TOPICS is hand-written JSON in wrangler.toml, so a typo there must not take
 * /add down with it — a broken list degrades to the single general topic.
 */
function topics(env: Env): Topic[] {
  if (!env.TOPICS) return [FALLBACK_TOPIC];

  let parsed: unknown;
  try {
    parsed = JSON.parse(env.TOPICS);
  } catch (error) {
    console.error("TOPICS is not valid JSON, falling back to general.", error);
    return [FALLBACK_TOPIC];
  }

  if (!Array.isArray(parsed)) {
    console.error("TOPICS must be an array, falling back to general.");
    return [FALLBACK_TOPIC];
  }

  const valid = parsed.filter(
    (item): item is Topic =>
      typeof item?.key === "string" &&
      typeof item?.label === "string" &&
      typeof item?.instruction === "string"
  );

  return valid.length > 0 ? valid : [FALLBACK_TOPIC];
}

function config(env: Env, name: keyof Env, fallback: number): number {
  const raw = env[name];
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) ? value : fallback;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    let update: {
      message?: {
        text?: unknown;
        chat?: { id?: unknown };
        reply_to_message?: { text?: unknown };
      };
      callback_query?: {
        id?: unknown;
        data?: unknown;
        message?: { text?: unknown; chat?: { id?: unknown } };
      };
    };
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const callback = update.callback_query;

    // Anyone who knows the bot's username can message it, so only the chats we
    // were configured for are served. Everything else is dropped silently.
    const chatId = String(
      (callback ? callback.message?.chat?.id : update.message?.chat?.id) ?? ""
    );
    if (!allowedChats(env).includes(chatId)) {
      return new Response("ignored", { status: 200 });
    }

    // Telegram retries a webhook it considers failed, which would double-grade
    // an answer. Returning 200 immediately and working in the background avoids that.
    if (callback) {
      const data = callback.data;
      const prompt = callback.message?.text;
      if (typeof data !== "string") {
        return new Response("ignored", { status: 200 });
      }
      ctx.waitUntil(
        guard(
          handleCallback(
            data,
            typeof prompt === "string" ? prompt : "",
            String(callback.id ?? ""),
            chatId,
            env
          ),
          chatId,
          env
        )
      );
      return new Response("ok", { status: 200 });
    }

    const text = update.message?.text;
    if (typeof text !== "string") {
      return new Response("ignored", { status: 200 });
    }

    const repliedTo = update.message?.reply_to_message?.text;

    ctx.waitUntil(
      guard(
        handleMessage(
          text.trim(),
          typeof repliedTo === "string" ? repliedTo : undefined,
          chatId,
          env
        ),
        chatId,
        env
      )
    );
    return new Response("ok", { status: 200 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Guard each chat separately: one failing chat must not cancel the others.
    ctx.waitUntil(
      Promise.all(
        allowedChats(env).map((chatId) =>
          guard(startSession(false, chatId, env), chatId, env)
        )
      )
    );
  },
};

function allowedChats(env: Env): string[] {
  return env.TELEGRAM_CHAT_IDS.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function guard(work: Promise<void>, chatId: string, env: Env): Promise<void> {
  try {
    await work;
  } catch (error) {
    console.error(error);
    await sendMessage("Something went wrong. Please try again.", chatId, env).catch(
      () => {}
    );
  }
}

const ADD_PROMPT = "Which word do you want to add?";
const TOPIC_PREFIX = "Topic for ";
const TOPIC_SUFFIX = "?";
const CALLBACK_PREFIX = "topic:";

async function handleMessage(
  text: string,
  repliedTo: string | undefined,
  chatId: string,
  env: Env
): Promise<void> {
  // Tapping /add in Telegram's command menu sends a bare "/add", so the bot
  // asks for the word and reads it from the reply. Matching on the prompt text
  // keeps this stateless, and keeps an open practice question undisturbed.
  if (repliedTo === ADD_PROMPT) {
    await askForTopic(text, chatId, env);
  } else if (text === "/add") {
    await promptForWord(chatId, env);
  } else if (text.startsWith("/add ")) {
    await askForTopic(text.slice(4).trim(), chatId, env);
  } else if (text === "/session") {
    await startSession(true, chatId, env);
  } else {
    await gradeAnswer(text, chatId, env);
  }
}

function promptForWord(chatId: string, env: Env): Promise<void> {
  return sendMessage(ADD_PROMPT, chatId, env, { force_reply: true });
}

/**
 * Second step of /add: the word is known, the topic is not. The word rides in
 * the prompt's own text rather than in callback_data, which Telegram caps at
 * 64 bytes — a long word would be truncated there, and silently so.
 */
async function askForTopic(word: string, chatId: string, env: Env): Promise<void> {
  if (!word) {
    await promptForWord(chatId, env);
    return;
  }

  // A cheap pre-check on the literal input: catches re-adding a word you typed
  // in English before spending a Claude call. The authoritative check runs in
  // addWord, on the English form Claude returns.
  const known = await readWords(chatId, env);
  const duplicate = known.find(
    (item) => item.word.toLowerCase() === word.toLowerCase()
  );
  if (duplicate) {
    await sendMessage(
      `"${duplicate.word}" — ${duplicate.meaning} is already on your list.`,
      chatId,
      env
    );
    return;
  }

  const choices = topics(env);
  if (choices.length === 1) {
    await addWord(word, choices[0]!, chatId, env);
    return;
  }

  await sendMessage(`${TOPIC_PREFIX}${word}${TOPIC_SUFFIX}`, chatId, env, {
    inline_keyboard: [
      choices.map((topic) => ({
        text: topic.label,
        callback_data: `${CALLBACK_PREFIX}${topic.key}`,
      })),
    ],
  });
}

async function handleCallback(
  data: string,
  promptText: string,
  callbackId: string,
  chatId: string,
  env: Env
): Promise<void> {
  // Telegram shows a loading spinner on the button until this is acknowledged.
  await answerCallbackQuery(callbackId, env).catch(() => {});

  if (!data.startsWith(CALLBACK_PREFIX)) return;

  const topic = topics(env).find(
    (candidate) => candidate.key === data.slice(CALLBACK_PREFIX.length)
  );
  const word =
    promptText.startsWith(TOPIC_PREFIX) && promptText.endsWith(TOPIC_SUFFIX)
      ? promptText.slice(TOPIC_PREFIX.length, -TOPIC_SUFFIX.length)
      : "";

  // Both can only fail if TOPICS changed between the prompt and the tap, or if
  // the prompt was edited away. Saying so beats adding a word under a topic
  // that no longer exists.
  if (!topic || !word) {
    await sendMessage("That choice expired. Try /add again.", chatId, env);
    return;
  }

  await addWord(word, topic, chatId, env);
}

async function startSession(
  announceIdle: boolean,
  chatId: string,
  env: Env
): Promise<void> {
  const active = await env.SESSIONS.get<ActiveSession>(sessionKey(chatId), "json");
  if (active) {
    if (announceIdle) {
      const open = active.questions[active.current];
      if (open) {
        await sendMessage(
          `You still have an open question:\n\n${open.question}`,
          chatId,
          env
        );
      }
    }
    return;
  }

  const words = await readWords(chatId, env);
  const candidates = selectCandidates(words, env);
  if (candidates.length === 0) {
    // On a schedule this would repeat at every cron tick, so the reminder is
    // capped at one a day. Asking directly always gets an answer.
    const today = new Date().toISOString().slice(0, 10);
    if (!announceIdle && (await env.SESSIONS.get(idleKey(chatId))) === today) {
      return;
    }
    await env.SESSIONS.put(idleKey(chatId), today);
    await sendMessage(
      words.length === 0
        ? "You have no words yet. Add your first one with /add <word>."
        : "Nothing to practise right now — everything you know is still resting. Add a word with /add <word>.",
      chatId,
      env
    );
    return;
  }

  const questions: Question[] = [];
  for (const candidate of candidates) {
    questions.push({
      word_id: candidate.word.id,
      word: candidate.word.word,
      meaning: candidate.word.meaning,
      direction: candidate.direction,
      question: await askQuestion(candidate.word, candidate.direction, env),
    });
  }

  const session: ActiveSession = { questions, current: 0 };
  await env.SESSIONS.put(sessionKey(chatId), JSON.stringify(session));

  const first = questions[0]!;
  const prefix = questions.length > 1 ? `(1/${questions.length}) ` : "";
  await sendMessage(prefix + first.question, chatId, env);
}

async function gradeAnswer(answer: string, chatId: string, env: Env): Promise<void> {
  const session = await env.SESSIONS.get<ActiveSession>(sessionKey(chatId), "json");
  const open = session?.questions[session.current];
  if (!session || !open) {
    await sendMessage(
      "No practice session is running. Start one with /session, or add a word with /add <word>.",
      chatId,
      env
    );
    return;
  }

  const evaluation = await evaluateAnswer(open, answer, env);

  // Record the result before advancing the session: if the dispatch fails, the
  // question stays open and the answer can be retried rather than silently lost.
  const payload: AnswerPayload = {
    chat_id: chatId,
    word_id: open.word_id,
    answer,
    result: evaluation.result,
    direction: open.direction,
  };
  await dispatch("flashc-answer", payload, env);

  const next = session.current + 1;
  const done = next >= session.questions.length;

  if (done) {
    await env.SESSIONS.delete(sessionKey(chatId));
  } else {
    await env.SESSIONS.put(
      sessionKey(chatId),
      JSON.stringify({ ...session, current: next })
    );
  }

  const mark = evaluation.result === "good" ? "✅" : "❌";
  await sendMessage(`${mark} ${evaluation.feedback}`, chatId, env);

  if (done) {
    // The CSV still lacks this session's answers — the Action commits them a
    // few seconds from now — so the report is one session behind. Close enough
    // for a nudge about the size of each band.
    await sendMessage(buildReport(await readWords(chatId, env), env), chatId, env);
  } else {
    const upcoming = session.questions[next]!;
    await sendMessage(
      `(${next + 1}/${session.questions.length}) ${upcoming.question}`,
      chatId,
      env
    );
  }
}

async function addWord(
  input: string,
  topic: Topic,
  chatId: string,
  env: Env
): Promise<void> {
  // Claude settles what actually goes in the CSV: the input may be Czech, or
  // capitalised, or not a word at all. It runs before the duplicate check
  // because only the English form it returns can be compared with the list.
  const details = await lookupWord(input, topic, env);
  const word = details.word.trim();

  if (!word || !details.meaning.trim()) {
    await sendMessage(
      `I don't know the word "${input}". Check the spelling and try /add again.`,
      chatId,
      env
    );
    return;
  }

  const known = await readWords(chatId, env);
  const duplicate = known.find(
    (item) => item.word.toLowerCase() === word.toLowerCase()
  );
  if (duplicate) {
    // Worth naming both forms: typing a Czech word gives no hint that the
    // English side is what already sits on the list.
    await sendMessage(
      `"${duplicate.word}" — ${duplicate.meaning} is already on your list.`,
      chatId,
      env
    );
    return;
  }

  const payload: AddPayload = {
    chat_id: chatId,
    word,
    meaning: details.meaning,
    example: details.example,
    start_level: config(env, "START_LEVEL", 2),
    topic: topic.key,
  };
  await dispatch("flashc-add", payload, env);
  await sendMessage(
    `➕ ${word} — ${details.meaning}\n[${topic.label}]\n\n${details.example}`,
    chatId,
    env
  );
}

function levelOf(word: Word, direction: Direction): number {
  return direction === "en_cs" ? word.level_en_cs : word.level_cs_en;
}

function practicedOf(word: Word, direction: Direction): string {
  return direction === "en_cs" ? word.practiced_en_cs : word.practiced_cs_en;
}

function daysSince(date: string): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const then = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (Date.now() - then) / 86_400_000;
}

function cooldownFor(level: number, env: Env): number {
  if (level >= MAX_LEVEL) return config(env, "COOLDOWN_8", 25);
  if (level >= 7) return config(env, "COOLDOWN_7", 12);
  return config(env, "COOLDOWN_6", 5);
}

export function selectCandidates(words: Word[], env: Env): Candidate[] {
  const all: Candidate[] = [];
  for (const word of words) {
    for (const direction of ["en_cs", "cs_en"] as const) {
      all.push({
        word,
        direction,
        level: levelOf(word, direction),
        practiced: practicedOf(word, direction),
      });
    }
  }

  const learning = all
    .filter((candidate) => candidate.level <= LEARNING_MAX)
    .sort((a, b) => a.level - b.level)
    .slice(0, config(env, "LEARNING_POOL", 10));

  // Known and mastered words compete on time, not level, and get their own
  // quota: ranked against the learning pile they would never surface once the
  // vocabulary grows.
  const review = all
    .filter(
      (candidate) =>
        candidate.level > LEARNING_MAX &&
        daysSince(candidate.practiced) >= cooldownFor(candidate.level, env)
    )
    .sort(
      (a, b) =>
        daysSince(b.practiced) - cooldownFor(b.level, env) -
        (daysSince(a.practiced) - cooldownFor(a.level, env))
    )
    .slice(0, config(env, "REVIEW_POOL", 5));

  const pool = [...learning, ...review];
  const wanted = Math.max(1, config(env, "WORDS_PER_SESSION", 1));
  const picked: Candidate[] = [];
  const usedWords = new Set<string>();

  while (picked.length < wanted && pool.length > 0) {
    const [candidate] = pool.splice(Math.floor(Math.random() * pool.length), 1);
    if (!candidate || usedWords.has(candidate.word.id)) continue;
    usedWords.add(candidate.word.id);
    picked.push(candidate);
  }

  return picked;
}

export function buildReport(words: Word[], env: Env): string {
  let learning = 0;
  let known = 0;
  let mastered = 0;

  for (const word of words) {
    const level = Math.max(word.level_en_cs, word.level_cs_en);
    if (level >= MAX_LEVEL) mastered++;
    else if (level > LEARNING_MAX) known++;
    else learning++;
  }

  const lines = [`📊 Learning ${learning} · Known ${known} · Mastered ${mastered}`];

  const learningWarn = config(env, "LEARNING_WARN", 40);
  if (learning > learningWarn) {
    lines.push(`⚠️ Learning: ${learning} words (limit ${learningWarn}) — consider reviewing`);
  }

  const reviewWarn = config(env, "REVIEW_WARN", 60);
  if (known + mastered > reviewWarn) {
    lines.push(
      `⚠️ Known+Mastered: ${known + mastered} words (limit ${reviewWarn}) — consider reviewing`
    );
  }

  return lines.join("\n");
}

async function readWords(chatId: string, env: Env): Promise<Word[]> {
  const path = wordsPath(chatId);
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "flashc-worker",
      },
    }
  );

  // A chat that has never added a word has no file yet. Only 404 means that —
  // a 401 or 500 must still throw, or a broken token would look like an empty
  // vocabulary and quietly reset someone's progress.
  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error(`Reading ${path} failed: ${response.status} ${await response.text()}`);
  }

  return parseCsv(await response.text()).map((row) => ({
    id: row.id ?? "",
    word: row.word ?? "",
    meaning: row.meaning ?? "",
    example: row.example ?? "",
    level_en_cs: Number(row.level_en_cs) || 0,
    level_cs_en: Number(row.level_cs_en) || 0,
    practiced_en_cs: row.practiced_en_cs ?? "",
    practiced_cs_en: row.practiced_cs_en ?? "",
  }));
}

async function dispatch(
  eventType: string,
  payload: AnswerPayload | AddPayload,
  env: Env
): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "flashc-worker",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: eventType, client_payload: payload }),
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub dispatch failed: ${response.status} ${await response.text()}`);
  }
}

async function answerCallbackQuery(callbackId: string, env: Env): Promise<void> {
  if (!callbackId) return;
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId }),
    }
  );
}

async function sendMessage(
  text: string,
  chatId: string,
  env: Env,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

type ClaudeCall<T> = {
  system: string;
  user: string;
  schema?: Record<string, unknown>;
  stub: () => T;
};

async function callClaude<T>({ system, user, schema, stub }: ClaudeCall<T>, env: Env): Promise<T> {
  if (!env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_API_KEY not set — using stubbed Claude response.");
    return stub();
  }

  const outputConfig: Record<string, unknown> = { effort: "low" };
  if (schema) {
    outputConfig.format = { type: "json_schema", schema };
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL ?? "claude-sonnet-5",
      max_tokens: 1000,
      output_config: outputConfig,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude request failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { content: { type: string; text?: string }[] };
  const text = body.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();

  return (schema ? JSON.parse(text) : text) as T;
}

function askQuestion(word: Word, direction: Direction, env: Env): Promise<string> {
  const system =
    direction === "en_cs"
      ? "You are an English tutor for a Czech learner. Ask one short flashcard question " +
        "about the target English word: what does it mean in Czech. " +
        "Output only the question, no preamble."
      : "You are an English tutor for a Czech learner. You are testing recall in the " +
        "harder direction: give the Czech meaning and ask which English word it is. " +
        "Never write the English word itself — that is the answer. " +
        "Output only the question, no preamble.";

  return callClaude<string>(
    {
      system,
      user: `English word: ${word.word}\nCzech meaning: ${word.meaning}\nExample: ${word.example}`,
      stub: () =>
        direction === "en_cs"
          ? `[stub] What does "${word.word}" mean in Czech?`
          : `[stub] Which English word means "${word.meaning}"?`,
    },
    env
  );
}
function evaluateAnswer(
  question: Question,
  answer: string,
  env: Env
): Promise<Evaluation> {
  const expecting =
    question.direction === "en_cs"
      ? "The learner should give the Czech meaning."
      : "The learner should give the English word.";

  return callClaude<Evaluation>(
    {
      system:
        "You grade a Czech learner's flashcard answer about an English word. " +
        `${expecting} Accept synonyms and minor typos. ` +
        "Mark 'bad' only if the meaning is wrong or missing. " +
        "Write the feedback in English, and confirm the correct answer briefly.",
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
        `English word: ${question.word}`,
        `Czech meaning: ${question.meaning}`,
        `Question asked: ${question.question}`,
        `Learner's answer: ${answer}`,
      ].join("\n"),
      stub: () => {
        const strip = (value: string) =>
          value.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
        const expected =
          question.direction === "en_cs" ? question.meaning : question.word;
        const hit = strip(expected)
          .split(/[;,]/)
          .some((variant) => strip(answer).includes(variant.trim()));
        return hit
          ? { result: "good", score: 0.9, feedback: `[stub] Correct — ${expected}.` }
          : { result: "bad", score: 0.2, feedback: `[stub] No, it is ${expected}.` };
      },
    },
    env
  );
}

function lookupWord(input: string, topic: Topic, env: Env): Promise<WordDetails> {
  return callClaude<WordDetails>(
    {
      system:
        "You help a Czech learner build an English vocabulary list. " +
        "The input is one word or phrase, in English or in Czech. " +
        "Return the English word in 'word', its Czech meaning in 'meaning', " +
        "and one natural example sentence in 'example'. " +
        // 'meaning' is also read back to the learner as the CS->EN question, so
        // a definition there both reads absurdly and gives the answer away.
        "'meaning' is a translation, not a definition: one to three Czech " +
        "words, or a few comma-separated variants. Never a whole clause, and " +
        "never a parenthetical gloss. " +
        "When the input is Czech, 'word' is its English translation. " +
        "Write 'word' the way a dictionary would: lowercase, unless it is a " +
        "proper noun or an acronym that is always capitalised. Drop any " +
        "leading 'to ' from verbs. " +
        "If the input is not a real word or phrase in either language — a typo " +
        "or random characters — return an empty string for all three fields. " +
        topic.instruction,
      schema: {
        type: "object",
        properties: {
          word: { type: "string" },
          meaning: { type: "string" },
          example: { type: "string" },
        },
        required: ["word", "meaning", "example"],
        additionalProperties: false,
      },
      user: `Input: ${input}`,
      stub: () => {
        // The stub cannot tell a word from gibberish, so it approximates:
        // vowel-less runs of letters are what typos usually look like.
        const normalised = input.toLowerCase().replace(/^to\s+/, "").trim();
        if (/^[a-z]{4,}$/.test(normalised) && !/[aeiouy]/.test(normalised)) {
          return { word: "", meaning: "", example: "" };
        }
        return {
          word: normalised,
          meaning: `[stub] ${topic.key} meaning of ${normalised}`,
          example: `[stub] This is an example with ${normalised}.`,
        };
      },
    },
    env
  );
}
