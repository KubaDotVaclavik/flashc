export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    // Telegram sends this header when a secret_token was set on the webhook.
    // Rejects any request that doesn't know our secret (e.g. random internet scans).
    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
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
      // Ignore non-text updates (stickers, edited messages, etc.) for this POC.
      return new Response("ignored", { status: 200 });
    }

    const dispatchPayload = {
      event_type: "telegram-message",
      client_payload: {
        chat_id: message.chat.id,
        from_id: message.from?.id,
        text: message.text,
        message_id: message.message_id,
        date: message.date,
      },
    };

    const ghResponse = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "flashc-telegram-relay",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(dispatchPayload),
      }
    );

    if (!ghResponse.ok) {
      const errText = await ghResponse.text();
      console.error("GitHub dispatch failed", ghResponse.status, errText);
      return new Response("upstream error", { status: 502 });
    }

    return new Response("ok", { status: 200 });
  },
};
