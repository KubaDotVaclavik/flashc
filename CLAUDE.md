# Personal English Learning Bot

Chci si vytvořit jednoduchý osobní systém pro učení angličtiny. Je to hobby projekt, takže preferuji **maximální jednoduchost, minimální provozní náklady a žádný vlastní server**.

## Cíl

Systém má fungovat jako osobní AI tutor:

1. Mám seznam anglických slovíček a dalších learning items.
2. Systém několikrát denně zjistí, co bych měl procvičovat.
3. AI mi přes **Telegram** pošle zprávu.
4. Já odpovím přímo v Telegramu.
5. AI vyhodnotí odpověď a pokračuje v interakci.
6. Po skončení procvičování se aktualizuje stav slovíčka.
7. Systém používá spaced repetition, aby rozhodoval, kdy se má slovíčko znovu objevit.

Nechci zatím budovat obecný „second brain“ ani složitou knowledge-base infrastrukturu.

---

# Technologie

Preferovaný stack:

* **GitHub** — repository a úložiště dat
* **CSV** — primární databáze
* **GitHub Actions** — serverless execution / scheduling
* **TypeScript / Node.js** — implementace
* **Claude API** — AI tutor a vyhodnocování odpovědí
* **Telegram Bot API** — komunikace s uživatelem

Žádný vlastní server, VPS ani PostgreSQL.

Počet slov bude pravděpodobně pouze **nižší stovky**, takže CSV je dostačující.

GitHub repository může být private.

---

# Základní architektura

```text
                  GitHub repository
                  ┌───────────────┐
                  │ words.csv     │
                  │ sessions.csv  │
                  │ reviews.csv   │
                  │ TypeScript    │
                  └───────┬───────┘
                          │
                    GitHub Actions
                          │
              ┌───────────┴───────────┐
              │                       │
         Claude API              Telegram API
              │                       │
              └───────────┬───────────┘
                          │
                        📱 User
                          │
                       response
                          │
                          ▼
                    GitHub Action
                          │
                          ▼
                      Claude API
                          │
                          ▼
                       Telegram
```

GitHub Actions bude sloužit jako jednoduchý orchestrátor. Nemá běžet permanentně.

---

# Datový model

Každý chat má vlastní soubor `data/chat_<chat_id>.csv`, takže bot obslouží víc
lidí i skupin, aniž by se jejich slovníky míchaly. Skupinová ID jsou záporná —
prefix `chat_` brání tomu, aby název začínal pomlčkou, kterou si shellové
nástroje vykládají jako přepínač.

Kdo smí bota používat, určuje secret `TELEGRAM_CHAT_IDS` (ID oddělená čárkami).
Zpráva odjinud se tiše ignoruje; CSV vznikne až prvním `/add` z povoleného chatu.

Aktivní session žije v Cloudflare KV pod klíčem `active_session:<chat_id>`, ne na
disku — historie procvičování se nikam neukládá, stačí konverzace v Telegramu.

```csv
id,word,meaning,example,level_en_cs,level_cs_en,practiced_en_cs,practiced_cs_en,tags
```

Příklad:

```csv
1,reluctant,neochotný,I was reluctant to accept the offer.,3,1,2026-09-21,2026-09-14,general
2,subtle,jemný; nepatrný,There is a subtle difference.,2,2,,,general
```

| Sloupec | Význam |
|---|---|
| `level_en_cs` | úroveň 0–8 pro směr EN→CS (vidíš `reluctant`, říkáš český význam) |
| `level_cs_en` | úroveň 0–8 pro směr CS→EN (vidíš `neochotný`, říkáš anglické slovo) |
| `practiced_en_cs` | datum posledního procvičení v tomto směru |
| `practiced_cs_en` | totéž pro druhý směr |

Každý směr se učí nezávisle: CS→EN (produkce) je těžší než EN→CS (rozpoznání),
takže jedna společná úroveň by slabší směr schovala za silnější.

Slovo se z učení vyřadí smazáním řádku.

---

# Učící algoritmus

Tři pásma:

| Pásmo | Level | Cooldown | Pád při chybě | Výběr |
|---|---|---|---|---|
| Learning | 0–5 | — | 1 | podle úrovně + random |
| Known | 6–7 | 5 / 12 dní | 2 | podle času |
| Mastered | 8 | 25 dní | 3 | podle času |

Nové slovo začíná na `START_LEVEL` (výchozí 2), takže do Known vedou 4 správné
odpovědi a do Mastered 6.

**Výběr do session** pracuje s kandidáty = dvojicemi (slovo, směr). Dvě skupiny
s pevnými kvótami, které spolu nesoutěží:

* **Learning** — seřadit podle úrovně vzestupně, vzít `LEARNING_POOL` nejslabších.
  Čas se neuplatňuje; u slova, které neumíš, je datum irelevantní.
* **Known/Mastered** — jen kandidáti po vypršení cooldownu, seřazení podle toho,
  jak dlouho jsou po něm; vzít nejvýš `REVIEW_POOL`.

Z výsledného poolu se náhodně losuje `WORDS_PER_SESSION` kandidátů, nejvýš jeden
směr na slovo. Oddělené kvóty jsou nutné — kdyby zralá slova soutěžila o prioritu
s učícími, při větším slovníku by neprošla nikdy.

Algoritmus tím nezávisí na počtu session za den ani na počtu slov v session.

Konfigurace je v `[vars]` v `flashc-worker/wrangler.toml`. Krok nahoru, pády
a hranice pásem jsou napevno v kódu — jsou to konstanty algoritmu, které na sobě
vzájemně závisí.

---

# AI / Claude

Claude nemá být databáze.

Jeho role:

* generovat přirozené otázky
* vést dialog
* přizpůsobovat se odpovědím
* přirozeně používat cílová slovíčka
* vyhodnotit uživatelovu angličtinu
* identifikovat chyby
* rozhodnout, zda uživatel cílové slovíčko skutečně použil správně

Deterministická logika má být v TypeScriptu:

* výběr due words
* výpočet spaced repetition
* změna `next_review`
* práce se sessions
* aktualizace CSV

Princip:

> **AI rozhoduje o jazyku a komunikaci. Kód rozhoduje o datech a learning algoritmu.**

---

# Dva základní režimy

## 1. Flashcard

Jednoduché procvičení:

```text
Claude:
What does "reluctant" mean?

User:
neochotný

Claude:
✓ Correct.

"reluctant" means unwilling or hesitant.
```

Po vyhodnocení se uloží review a aktualizuje learning state.

---

# 2. Dialog

Chci, aby systém uměl i skutečný krátký dialog.

Například **5 zpráv Claude + 5 odpovědí uživatele**.

Claude dostane:

* cílové slovíčko
* případně několik cílových slov
* úroveň uživatele, pokud ji budeme chtít definovat
* instrukci vést přirozený dialog
* dosavadní historii konverzace

Například:

```text
Claude:
Hey! I heard your company is introducing a new tool.
Are you looking forward to using it?

User:
Not really. I'm a bit reluctant because I already have too many tools to learn.

Claude:
That makes sense. What would make you feel more comfortable with it?

User:
...
```

Dialog má být **skutečně interaktivní**, nikoli předgenerovaný.

Claude musí reagovat na skutečnou odpověď uživatele.

---

# Multi-turn komunikace

Claude API je stateless, takže při každém requestu se pošle potřebná historie:

```text
system prompt
+
target vocabulary
+
conversation history
+
latest user message
```

Příklad:

```text
System:
You are an English conversation tutor...

Target:
reluctant

Conversation:

Claude:
Hey! I heard...

User:
Not really. I'm a bit reluctant...

Claude:
That makes sense...

User:
...
```

Po každém kole Claude vrátí další zprávu.

10 zpráv tedy může znamenat přibližně 10 API requestů.

To je přijatelné.

---

# Ukončení dialogu

Po 5 odpovědích uživatele má Claude provést krátké vyhodnocení.

Například strukturovaný výstup:

```json
{
  "vocabulary": {
    "reluctant": "used correctly"
  },
  "grammar": [
    {
      "original": "...",
      "suggestion": "...",
      "severity": "minor"
    }
  ],
  "fluency": "good",
  "result": "good"
}
```

TypeScript následně:

1. zapíše review do `reviews.csv`
2. aktualizuje `words.csv`
3. spočítá další `next_review`
4. ukončí session

---

# Claude API usage

Usage má být minimalizované.

Claude se nemá volat kvůli každému jednoduchému databázovému rozhodnutí.

Claude se používá pouze tam, kde je potřeba AI:

* vytvoření otázky
* konverzace
* vyhodnocení odpovědi

CSV se zpracovává lokálně v GitHub Action.

Při stovkách slov a několika interakcích denně by měl být API usage velmi malý.

---

# GitHub Actions

GitHub Actions má řešit dvě hlavní situace.

## Scheduled job

Například několikrát denně:

```text
08:00
13:00
19:00
```

Workflow:

```text
load words.csv
↓
find words where next_review <= now
↓
select appropriate word(s)
↓
create session
↓
call Claude
↓
send Telegram message
↓
commit updated sessions.csv
```

## Response handling

Telegram bot musí nějakým způsobem předat uživatelovu odpověď zpět systému.

Workflow následně:

```text
Telegram message
↓
identify active session
↓
load session + history
↓
call Claude
↓
generate next response
↓
send Telegram message
↓
update session
↓
commit changes
```

Je potřeba navrhnout konkrétní mechanismus pro příjem Telegram zpráv. Preferujeme řešení bez permanentně běžícího serveru.

---

# Důležitý požadavek: jednoduchost

Toto je **osobní hobby projekt**, nikoli produkční SaaS.

Proto:

* žádná PostgreSQL
* žádný vlastní backend server
* žádná Kubernetes/cloud infrastruktura
* žádná zbytečná abstrakce
* žádný komplexní agent framework
* žádný vector database
* žádné embeddings, pokud pro ně nebude konkrétní důvod

Preferuji několik jednoduchých TypeScript funkcí a CSV.

---

# Budoucí rozšíření

Architektura by měla umožnit později přidat další typy procvičování:

```text
flashcard
translation
dialog
writing
correction
```

A případně později i další knowledge items mimo angličtinu.

Ale **nenavrhovat nyní obecný knowledge-management systém**. Angličtina je první a hlavní use case.

---

# Preferovaný způsob další práce

Nejdříve navrhnout konkrétní MVP:

1. strukturu repository
2. přesný formát CSV
3. Telegram Bot API flow
4. Claude API flow
5. GitHub Actions workflows
6. způsob, jak přijímat Telegram odpovědi bez permanentního serveru
7. spaced-repetition algoritmus
8. minimální TypeScript implementaci

Potom implementovat postupně.

Při návrhu preferovat **nejjednodušší řešení, které splní požadavky**, nikoli enterprise architecture.