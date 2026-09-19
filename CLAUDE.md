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

## words.csv

Minimální návrh:

```csv
id,word,meaning,example,state,next_review,interval,ease,successes,failures,tags,notes
```

Příklad:

```csv
42,reluctant,neochotný,"I was reluctant to accept the offer.",learning,2026-09-20,2,2.5,4,1,work,
43,subtle,"jemný; nepatrný","There is a subtle difference.",familiar,2026-09-22,4,2.6,5,1,general,
44,cumbersome,těžkopádný,"The process is cumbersome.",new,,,,0,0,work,
```

Nemusíme implementovat všechny sloupce hned. Návrh je otevřený úpravám.

Možné states:

```text
new
learning
familiar
mastered
suspended
```

Důležitější než samotný state je `next_review`.

---

# reviews.csv

Historie procvičování:

```csv
timestamp,word_id,type,direction,result,score,notes
```

Příklad:

```csv
2026-09-18T12:15:00Z,42,dialog,EN->EN,good,0.9,"Used target word correctly"
```

Historie nemusí obsahovat kompletní transcript dialogu, pokud k tomu nebude důvod.

---

# sessions.csv

Pro aktivní konverzace:

```csv
id,date,word_id,type,status,turn
```

Například:

```csv
abc123,2026-09-18,42,dialog,active,4
```

Po dokončení:

```csv
abc123,2026-09-18,42,dialog,completed,10
```

Session umožňuje GitHub Action zjistit, že uživatel odpověděl a konverzace má pokračovat.

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

## Plánované features

### Osvěžování naučených slovíček

Slovíčka ve stavu `mastered` se po delší době znovu zařadí do výuky, aby se osvěžila.

Dnešní chování: `applyReview()` po šesti úspěších nastaví `mastered` a interval dál roste
exponenciálně, takže slovo prakticky vypadne z oběhu.

K rozhodnutí: strop na interval (např. max 180 dní), nebo občasná náhodná refresh otázka
mimo `next_review`.

### Opačný směr překladu

Procvičovat i CS→EN, nejen EN→CS.

`reviews.csv` už sloupec `direction` má, ale zapisuje se do něj natvrdo `EN->CS`.
Bude potřeba směr vybírat (náhodně, nebo podle toho, který je slabší), předat ho
do `generateQuestion()` a do vyhodnocení.

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