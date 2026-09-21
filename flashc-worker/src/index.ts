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
  CLAUDE_MODEL_FAST?: string;
  LOG_UPDATES?: string;
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

    type Sender = { id?: unknown; username?: unknown };
    let update: {
      message?: {
        text?: unknown;
        from?: Sender;
        chat?: { id?: unknown };
        reply_to_message?: { text?: unknown };
      };
      callback_query?: {
        id?: unknown;
        data?: unknown;
        from?: Sender;
        message?: { message_id?: unknown; text?: unknown; chat?: { id?: unknown } };
      };
    };
    const raw = await request.text();
    // The whole update, as Telegram sent it, for `wrangler tail`. It carries the
    // sender's name and every word of the message, so it is off unless
    // LOG_UPDATES is set — and the webhook secret never appears in the body.
    if (env.LOG_UPDATES === "true") {
      console.log(`Telegram update: ${raw.slice(0, 4000)}`);
    }

    try {
      update = JSON.parse(raw);
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
      // Anyone who knows the bot's username can reach this, so it is worth
      // seeing. Logged unconditionally — a stranger trying the bot is a
      // security event, not debugging — but without their message: the id is
      // what identifies them, and it is what TELEGRAM_CHAT_IDS would need.
      const from = callback ? callback.from : update.message?.from;
      console.warn(
        `Ignored a message from chat ${chatId || "(unknown)"}` +
          ` (user ${String(from?.id ?? "unknown")}, @${String(from?.username ?? "-")}).`
      );
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
            {
              data,
              promptText: typeof prompt === "string" ? prompt : "",
              callbackId: String(callback.id ?? ""),
              messageId: Number(callback.message?.message_id ?? 0),
            },
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

// Messages go out as HTML, where a bare "/add <word>" reads as an opening tag
// and costs the whole message. The placeholder is marked up as code instead.
const ADD_USAGE = "/add <code>&lt;word&gt;</code>";
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
      `${bold(duplicate.word)} — ${escapeHtml(duplicate.meaning)} is already on your list.`,
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

  // The word is read back out of this text when a button is tapped, and what
  // comes back is the rendered message, so it is escaped on the way out and
  // compared against the rendering, never against the markup.
  await sendMessage(`${TOPIC_PREFIX}${escapeHtml(word)}${TOPIC_SUFFIX}`, chatId, env, {
    inline_keyboard: [
      choices.map((topic) => ({
        text: topic.label,
        callback_data: `${CALLBACK_PREFIX}${topic.key}`,
      })),
    ],
  });
}

type CallbackTap = {
  data: string;
  promptText: string;
  callbackId: string;
  messageId: number;
};

async function handleCallback(
  { data, promptText, callbackId, messageId }: CallbackTap,
  chatId: string,
  env: Env
): Promise<void> {
  // Telegram shows a loading spinner on the button until this is acknowledged.
  await answerCallbackQuery(callbackId, env).catch(() => {});

  if (!data.startsWith(CALLBACK_PREFIX)) return;

  // Looking the word up takes a second or two, and the buttons stay tappable
  // the whole time, which invites a second tap and a second word. Taking them
  // away first makes the first tap the only one that can do anything: a later
  // tap on a cached keyboard finds no buttons to edit and stops here.
  const claimed = await clearButtons(messageId, chatId, env);
  if (!claimed) return;

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

  // Looking the word up runs for a second or two with nothing on screen, which
  // is the other half of why the buttons got tapped twice. Restating the choice
  // shows the tap landed.
  await editMessage(
    `${TOPIC_PREFIX}${word}${TOPIC_SUFFIX} ${topic.label} — looking it up…`,
    messageId,
    chatId,
    env
  );

  await addWord(word, topic, chatId, env);
}

/**
 * Questions are what the learner has to act on, so they carry a marker that
 * sets them apart from feedback and reports in a busy chat. One place, so the
 * three spots a question can be sent from cannot drift apart.
 */
function questionText(question: string, index: number, total: number): string {
  const counter = total > 1 ? ` (${index + 1}/${total})` : "";
  // askQuestion builds this, escaping as it goes, so it is already HTML.
  return `❓${counter} ${question}`;
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
          "You still have an open question:\n\n" +
            questionText(open.question, active.current, active.questions.length),
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
        ? `You have no words yet. Add your first one with ${ADD_USAGE}.`
        : `Nothing to practise right now — everything you know is still resting. Add a word with ${ADD_USAGE}.`,
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
      question: askQuestion(candidate.word, candidate.direction),
    });
  }

  const session: ActiveSession = { questions, current: 0 };
  await env.SESSIONS.put(sessionKey(chatId), JSON.stringify(session));

  await sendMessage(
    questionText(questions[0]!.question, 0, questions.length),
    chatId,
    env
  );
}

async function gradeAnswer(answer: string, chatId: string, env: Env): Promise<void> {
  const session = await env.SESSIONS.get<ActiveSession>(sessionKey(chatId), "json");
  const open = session?.questions[session.current];
  if (!session || !open) {
    await sendMessage(
      `No practice session is running. Start one with /session, or add a word with ${ADD_USAGE}.`,
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
  // Claude writes this as Telegram HTML; sendMessage falls back to plain text
  // if it turns out malformed.
  await sendMessage(`${mark} ${evaluation.feedback}`, chatId, env);

  if (done) {
    // The CSV still lacks this session's answers — the Action commits them a
    // few seconds from now — so the report is one session behind. Close enough
    // for a nudge about the size of each band.
    await sendMessage(buildReport(await readWords(chatId, env), env), chatId, env);
  } else {
    await sendMessage(
      questionText(session.questions[next]!.question, next, session.questions.length),
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
  // The schema requires all three, but this is a model's JSON: a missing field
  // should read as "I don't know that word", not crash the handler.
  const word = (details.word ?? "").trim();

  if (!word || !(details.meaning ?? "").trim()) {
    await sendMessage(
      `I don't know the word ${bold(input)}. Check the spelling and try /add again.`,
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
      `${bold(duplicate.word)} — ${escapeHtml(duplicate.meaning)} is already on your list.`,
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
    `➕ ${bold(word)} — ${escapeHtml(details.meaning)}\n` +
      `<i>${escapeHtml(topic.label)}</i>\n\n` +
      `${escapeHtml(details.example)}`,
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

/**
 * Removes a message's buttons, and reports whether this call is the one that
 * removed them. Telegram rejects an edit that changes nothing with "message is
 * not modified", which is exactly the second tap: the keyboard is already gone,
 * so that tap has lost the race and must not act.
 */
async function clearButtons(
  messageId: number,
  chatId: string,
  env: Env
): Promise<boolean> {
  if (!messageId) return true;

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    }
  );

  if (response.ok) return true;

  const body = await response.text();
  if (body.includes("message is not modified")) return false;

  // Any other failure (a deleted message, a network blip) must not silently
  // swallow the tap: better to add the word twice than not at all.
  console.error(`editMessageReplyMarkup failed: ${response.status} ${body}`);
  return true;
}

/** Rewrites a message in place. Cosmetic, so a failure must not stop the work. */
async function editMessage(
  text: string,
  messageId: number,
  chatId: string,
  env: Env
): Promise<void> {
  if (!messageId) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
      }
    );
  } catch (error) {
    console.error("editMessageText failed", error);
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

/**
 * Escapes text for Telegram's HTML parse mode. Everything that reaches a
 * message and was not written here — a word, a Czech meaning, Claude's
 * feedback — goes through this, or an stray "<" costs the whole message:
 * Telegram rejects malformed HTML outright rather than sending it as-is.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Bold, for the one word a message is really about. */
function bold(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

/** Strips tags and resolves entities, for when the HTML turns out to be broken. */
function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function post(
  method: string,
  body: Record<string, unknown>,
  env: Env
): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sendMessage(
  text: string,
  chatId: string,
  env: Env,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  const markup = replyMarkup ? { reply_markup: replyMarkup } : {};
  const response = await post(
    "sendMessage",
    { chat_id: chatId, text, parse_mode: "HTML", ...markup },
    env
  );

  if (response.ok) return;

  const body = await response.text();

  // Telegram refuses a message whose markup is malformed rather than sending it
  // plain, and some of this text is written by Claude. Losing the formatting is
  // an acceptable outcome; losing the feedback is not.
  if (body.includes("can't parse entities")) {
    console.error(`Falling back to plain text: ${body}`);
    const retry = await post(
      "sendMessage",
      { chat_id: chatId, text: stripHtml(text), ...markup },
      env
    );
    if (retry.ok) return;
    throw new Error(
      `Telegram sendMessage failed even as plain text: ${retry.status} ${await retry.text()}`
    );
  }

  throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
}

type ClaudeCall<T> = {
  system: string;
  user: string;
  schema?: Record<string, unknown>;
  /**
   * Asking and grading are small, mechanical jobs and go to the cheap model;
   * writing a word's meaning and example is the one that benefits from the
   * better one. Roughly two thirds off the running cost.
   */
  model: "fast" | "good";
  stub: () => T;
};

async function callClaude<T>(
  { system, user, schema, model, stub }: ClaudeCall<T>,
  env: Env
): Promise<T> {
  if (!env.ANTHROPIC_API_KEY) {
    console.warn("ANTHROPIC_API_KEY not set — using stubbed Claude response.");
    return stub();
  }

  const modelId =
    model === "fast"
      ? env.CLAUDE_MODEL_FAST ?? "claude-haiku-4-5-20251001"
      : env.CLAUDE_MODEL ?? "claude-sonnet-5";

  const outputConfig: Record<string, unknown> = {};
  // Haiku 4.5 rejects the effort parameter outright, so it is sent only to the
  // models that have it. Its absence costs nothing here: these replies are a
  // few dozen tokens either way.
  if (!/haiku/i.test(modelId)) {
    outputConfig.effort = "low";
  }
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
      model: modelId,
      // Replies here are a question, a sentence of feedback, or a short JSON
      // object — a few dozen tokens. The old 1000 was never approached.
      max_tokens: 300,
      // Asking a question on Haiku leaves nothing to configure, and an empty
      // object is not worth sending.
      ...(Object.keys(outputConfig).length > 0
        ? { output_config: outputConfig }
        : {}),
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

/**
 * Builds the question instead of asking Claude for it. A flashcard question has
 * exactly one shape, so a model only added variation ("how do you say…" one
 * time, "which English word is…" the next) along with a call, a second or two
 * of waiting, and one more chance to emit markup that Telegram would refuse.
 */
function askQuestion(word: Word, direction: Direction): string {
  if (direction === "en_cs") {
    return `What does ${bold(word.word)} mean in Czech?`;
  }

  // "jemný; nepatrný" asked whole reads badly and gives away how many senses
  // the word has, so only the first one is put to the learner. The grader still
  // sees them all and accepts any.
  const [primary = word.meaning] = word.meaning.split(/[;,]/);
  return `Which English word means ${bold(primary.trim())}?`;
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
      model: "fast",
      system:
        "You grade a Czech learner's flashcard answer about an English word. " +
        `${expecting} The expected answer is given to you; grade against it. ` +
        // Grammar is not what a flashcard tests, but spelling is: a learner who
        // is never told about a typo keeps making it.
        "Accept an answer whose form differs but whose word is right: a " +
        "different gender, number, case or verb aspect, a missing diacritic, " +
        "or a different capitalisation. Accept a genuine synonym, even one " +
        "not listed, and accept an answer that gives only one of several " +
        "listed meanings. " +
        "Do not accept a misspelling. If the word is spelled wrong, mark it " +
        "'bad' and show the correct spelling, even when you can tell what was " +
        "meant. " +
        "Mark 'bad' when the answer is wrong, missing, or says nothing — " +
        `"I don't know" is 'bad'. ` +
        // A fixed shape, so the feedback reads the same every time instead of
        // being reinvented per answer.
        "Write the feedback in English as one line, in exactly this shape: " +
        "the correct answer first, in bold, then an em dash, then at most one " +
        "short sentence. For a correct answer that sentence is optional; for a " +
        "wrong one, say briefly what was wrong. " +
        "Example: <b>subtle</b> — you wrote the opposite. " +
        // Telegram parses this as HTML and refuses the whole message if the
        // markup is malformed, so the rules are spelled out rather than assumed.
        "Use Telegram HTML: only <b>, <i> and <code>, each properly closed. " +
        "Write &amp; for &, &lt; for < and &gt; for >, everywhere in the text. " +
        "Use no other tags and no Markdown.",
      schema: {
        type: "object",
        properties: {
          result: { type: "string", enum: ["good", "bad"] },
          feedback: { type: "string" },
        },
        required: ["result", "feedback"],
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
          ? { result: "good", feedback: `${bold(expected)} — [stub] correct.` }
          : { result: "bad", feedback: `${bold(expected)} — [stub] not what you wrote.` };
      },
    },
    env
  );
}

function lookupWord(input: string, topic: Topic, env: Env): Promise<WordDetails> {
  return callClaude<WordDetails>(
    {
      // The one call whose output is stored and read for years.
      model: "good",
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
