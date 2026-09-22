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

* **GitHub** — repository a úložiště dat (přes Contents API)
* **CSV** — primární databáze
* **Cloudflare Worker** — veškerá logika i scheduling (cron triggers)
* **TypeScript** — implementace
* **Claude API** — AI tutor a vyhodnocování odpovědí
* **Telegram Bot API** — komunikace s uživatelem

Žádný vlastní server, VPS ani PostgreSQL.

Počet slov bude pravděpodobně pouze **nižší stovky**, takže CSV je dostačující.

GitHub repository může být private.

---

# Základní architektura

```text
   GitHub repository            Cloudflare Worker
   ┌─────────────────┐          ┌──────────────────────┐
   │ data/chat_*.csv │◀────────▶│ webhook (odpovědi)   │
   └─────────────────┘  Contents│ cron (3× denně)      │
                            API │ KV: aktivní session  │
                                └──────┬────────┬──────┘
                                       │        │
                                 Claude API   Telegram API
                                                │
                                              📱 User
```

Všechna logika je ve Workeru: ptá se, hodnotí, počítá úrovně a zapisuje CSV
přímo přes GitHub Contents API (`PUT` = změna souboru i commit v jednom
volání). GitHub je čistě úložiště, žádné Actions.

Zápis posílá celý soubor — Contents API nezná částečnou úpravu. Při několika
stovkách slov jde o jednotky kilobajtů.

Souběžný zápis hlídá `sha` blobu: při konfliktu vrátí GitHub 409 a odpověď se
nezapíše (dostaneš chybovou hlášku a odpovíš znovu). Každý chat má vlastní
soubor, takže nastat může jen při dvou odpovědích téhož člověka naráz.

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
id,word,meaning,example,level_en_cs,level_cs_en,practiced_en_cs,practiced_cs_en,topic
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
| `topic` | téma slova, vybrané při `/add` (např. `it`, `general`) |

Každý směr se učí nezávisle: CS→EN (produkce) je těžší než EN→CS (rozpoznání),
takže jedna společná úroveň by slabší směr schovala za silnější.

Slovo se z učení vyřadí smazáním řádku.

## Témata

Seznam témat je JSON v `TOPICS` ve `wrangler.toml`; každé má `key` (jde do
`topic`), `label` (text tlačítka) a `instruction` pro Claude.

`/add` proto běží ve dvou krocích: nejdřív slovo, pak téma přes inline keyboard.
Claude se volá až po výběru — dřív nemá podle čeho `meaning` a `example`
přizpůsobit. Slovo čeká mezi kroky v textu výzvy („Topic for *slovo*?"), ne
v KV: `callback_data` má limit 64 bajtů a delší slovo by tiše uťalo.

Téma ovlivňuje jen generování při `/add`. Výběr slov do session na něm
nezávisí — filtr podle tématu by znamenal, že se slova z ostatních témat
přestanou objevovat úplně.

## Zadávání slov

Zadat lze česky i anglicky. Do `word` jde vždy anglický tvar, který určí
Claude — ten zároveň řekne, jestli slovo vůbec existuje. Nesmysl se odmítne
a nic se nezapíše.

Tvar slova neurčuje kód, ale Claude: lowercase, ale `Docker` a `API` si
velké písmeno nechají, a u sloves se zahazuje úvodní `to `. Tvrdý
`toLowerCase()` by vlastní jména a zkratky rozbil.

Duplicita se proto kontroluje až na přeloženém tvaru — `neochotný` musí
najít existující `reluctant`. Před voláním Claude běží ještě levná
kontrola na doslovný vstup, která ušetří API volání, když přidáváš slovo,
co už anglicky máš.

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

* výběr kandidátů do session
* změna úrovně po odpovědi
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

Worker následně:

1. posune úroveň procvičovaného směru
2. zapíše CSV zpět na GitHub
3. ukončí session a pošle report

---

# Claude API usage

Usage má být minimalizované.

Claude se nemá volat kvůli každému jednoduchému databázovému rozhodnutí.

Claude se používá pouze tam, kde je potřeba AI:

* vyhodnocení odpovědi
* překlad a příklad při `/add`
* konverzace (dialogový režim, zatím neimplementováno)

Flashcard otázka se **skládá v kódu** — má jeden tvar, takže by model jen
přidával rozptyl a další volání.

CSV zpracovává Worker; GitHub je jen úložiště.

Při stovkách slov a několika interakcích denně by měl být API usage velmi malý.

---

# Běhy Workeru

## Cron

Třikrát denně (`0 6,11,17 * * *` UTC, tedy 8:00/13:00/19:00 letního času):

```text
pro každý chat v TELEGRAM_CHAT_IDS:
  je otevřená session? → připomenout otevřenou otázku a skončit
  ↓
  načíst CSV z GitHubu
  ↓
  vybrat kandidáty (viz Učící algoritmus)
  ↓
  složit otázky, uložit session do KV
  ↓
  poslat první otázku
```

Připomínka otevřené otázky je důležitá: session se ukončí jen dokončením, takže
bez ní by nedokončená session bota umlčela natrvalo.

## Odpověď uživatele

```text
Telegram webhook
↓
ověřit secret_token a chat id
↓
načíst session z KV
↓
Claude vyhodnotí odpověď
↓
načíst CSV (+ sha) → applyLevel → PUT zpět na GitHub
↓
poslat feedback
↓
zbývá otázka? → poslat další; jinak smazat session a poslat report
```

Zápis je záměrně **před** posunem session: kdyby selhal, otázka zůstane
otevřená a odpověď se dá dát znovu, místo aby se tiše ztratila.

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