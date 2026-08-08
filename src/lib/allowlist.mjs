// tuipr — ALLOWLIST: a claude-hívás IZOLÁCIÓJA és engedély-politikája.
//
// Ami itt lakik: a setting-sources (a user-szintű CLAUDE.md kizárása), az
// allowed/disallowed tool-listák, a permission-realitás prompt-blokk és a
// denial-üzenetek.
//
// TISZTA KONSTANS+FORMÁZÓ RÉTEG: NULLA projekt-import (mérve). Ez szándékos —
// így a token-határos, csapdás tesztek egy KIS fájlt címeznek, nem a 6000
// sorosat.
//
// A LISTÁK BŐVÍTÉSÉNEK HELYE EZ A FÁJL (a denial-üzenet is ide irányít).

// --- IZOLÁCIÓ: a user-szintű CLAUDE.md kizárása ------------------------------
//
// A MÉRT LELET: a review-agent a user gépén `claude-usage gate; echo "exit=$?"`
// futtatásába kezdett — ez az utasítás a USER-SZINTŰ globális CLAUDE.md-ből
// szivárgott be (az utasítja az agentet gate-futtatásra minden komolyabb munka
// előtt). A review-agentnek a user workflow-instrukcióihoz semmi köze.
//
// A MÉRÉS (claude 2.1.238, 2026-08-03, két minimál haiku-próba a mobile
// checkoutban, --max-budget-usd plafonnal):
//   1. `--setting-sources project,local` + "látsz-e claude-usage gate
//      utasítást?" → user_md: FALSE, project_md: TRUE — a user-szintű CLAUDE.md
//      kizárva, a PROJEKT CLAUDE.md megmarad.
//   2. Ugyanez `--tools Skill` mellett → agent_review_available: TRUE — a
//      projekt-szintű skillek/slash-parancsok (.claude/commands/agent-review.md)
//      NEM settings-forrásból jönnek, tehát elérhetők maradnak.
//   3. A `--bare` NEM alternatíva: a `--help` szerint bare módban "OAuth and
//      keychain are never read" — a subscription-authos usernél maga az auth
//      halna meg. A `--setting-sources` a szűkebb, célzott eszköz.
export const AI_REVIEW_SETTING_SOURCES = 'project,local'
export const AI_REVIEW_SETTING_SOURCES_ARGS = ['--setting-sources', AI_REVIEW_SETTING_SOURCES]

/**
 * A PERMISSION-ALLOWLIST — a `--tools`-tól FÜGGETLEN, MÁSODIK kapu.
 *
 * MIÉRT KELL (MÉRT ÉLES BLOKKOLÓ, claude 2.1.220, a #904-es futás gyökere):
 * a `--tools` CSAK a tool-KÉSZLETET szűkíti; azt, hogy egy engedélyezett tool
 * konkrét hívása LEFUT-E, a permission-réteg dönti el. A TUI
 * `--permission-mode dontAsk`-kal indít (non-interaktívban nincs, aki
 * válaszoljon a promptra), a user `~/.claude/settings.json`-jában viszont
 * `"allow": []` áll — és ilyenkor a Bash-hívások DENIED lesznek. IZOLÁLTAN
 * MÉRVE (`--setting-sources ''` + üres allowlistes settings, `--tools Bash`,
 * `dontAsk`, prompt: `gh pr view 1 --json title`):
 *
 *   subtype=success, is_error=false, permission_denials=[{
 *     "tool_name":"Bash","tool_use_id":"toolu_014PyJ…",
 *     "tool_input":{"command":"gh pr view 1 --json title ."}}]
 *
 * Vagyis a burkoló SIKERT jelent, a review viszont egy lépést sem tett meg. Ez
 * a #904-es hazug-végállapot osztály LEGSÚLYOSABB tagja: a user gépén az
 * AI-review ELVI SZINTEN járhatatlan volt.
 *
 * A MEGOLDÁS A CLI-BEN MEGVAN, ÉS MÉRVE HAT: ugyanaz a hívás
 * `--allowedTools 'Bash(gh pr view:*)'`-szal `permission_denials: []`-t adott.
 * A flag tehát a `dontAsk` MELLETT is érvényesül, és NEM igényli a user
 * `settings.json`-jának módosítását — az az ő gépe, nem a mi dolgunk.
 *
 * MIÉRT PREFIX-MINTÁK ÉS NEM CSUPASZ `Bash`: egy csupasz `Bash` az EGÉSZ
 * shellt engedélyezné, és ezzel a `--tools` szűkítése (nincs Write/Edit, az
 * agent a REPÓT nem módosíthatja) értelmét vesztené — a Bash-en bármi átmegy.
 * A `Bash(<prefix>:*)` a MÉRT szintaxis (`claude --help`: `"Bash(git *) Edit"`),
 * és a lista PONTOSAN a review-hoz kellő parancsokat fedi.
 *
 * A LISTA FORRÁSA KÉT MÉRÉS:
 *   1. a #904-es futás naplója: ott a `gh pr view`, a `hunk session list` és a
 *      `git log` lett denied; a `gh pr diff` és a `git diff` a promptban
 *      kimondottan szerepel;
 *   2. a user élő tesztjének denial-listája + az agent-review skill LELTÁRA
 *      (mobile repo `.claude/commands/agent-review.md`, 478 sor). A skill
 *      lokális futása TÉNYLEGESEN hívja: `gh pr diff`/`gh pr view` (STEP 2),
 *      `pnpm exec list-changed-files` (STEP 2), `gh api repos/…/pulls/N/
 *      reviews|comments --paginate` (STEP 4b reconciliation + REVIEW_COUNT),
 *      a jira MCP-t (sweep-jira-compliance: a ticket betöltése), és Task-kal
 *      delegál (8 párhuzamos sweep + validation). A user mérésében a
 *      `gh pr checks`, a `gh api …/pulls/904/reviews` és a
 *      `mcp__atlassian__jira_get` lett denied — mind olvasó út.
 *
 * AMI SZÁNDÉKOSAN NINCS BENT: a csupasz `Bash` (az egész shell), a mutáló gh-utak
 * (`gh pr comment/review/merge` — a human-in-the-loop kapu megkerülése lenne),
 * és a MUTÁLÓ jira-toolok (jira_comment/create/update/transition). A `gh api`
 * allow-ja prefix-minta, tehát a `-X POST`-ot ELVBŐL nem tudja kizárni — azt a
 * prompt explicit tilalma és az AI_REVIEW_DISALLOWED_TOOLS fedi (deny > allow).
 */
export const AI_REVIEW_ALLOWED_TOOLS = [
  // A PR metaadata és diffje — a review BEMENETE.
  'Bash(gh pr:*)',
  // A CI-státusz — a user mérésében denied volt (`gh pr checks 904 …`).

  // A gh api OLVASÁSOK: reviews/comments (reconciliation, REVIEW_COUNT).
  // MÉRT CSAPDA: a `gh api repos:*` minta NEM illeszkedett a
  // `gh api repos/<org>/...` hívásra — az illesztés token-határos, a
  // `repos` token != `repos/<org>/...`. Ezért az `api` teljes token után
  // zárunk. A mutációt (gh api -f/-X POST) a prompt tiltja — prefixszel nem
  // kifejezhető; dokumentált, vállalt maradvány-kockázat (saját orchestrált
  // review-agent, explicit no-mutation instrukcióval).
  'Bash(gh api:*)',
  // Az agent-review STEP 2 fájl-listázója (repo-lokális, read-only script).
  'Bash(pnpm exec list-changed-files:*)',
  // A hunk-CLI: az agent IDE írja a findingokat (ez a v2-út egész lényege).
  'Bash(hunk:*)',
  // A lokális git-történet és diff — a finding kontextusa.
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  // A user 3. elhasalt futásának denialjei: keresés és CI-log — mind olvasó.
  'Bash(git grep:*)',
  'Bash(gh run:*)',
  // A user 4. futásának MÉRT denialjei — mindkettő olvasó út:
  //   - `git ls-tree`: a repo-fa listázása (a review a struktúrát nézi);
  //   - az eslint MCP `lint-files` toolja: a lint-sweep legitim olvasó útja —
  //     az agent a PROJEKT MCP-szervereit örökli (--setting-sources project),
  //     tehát a tool elérhető, csak a permission-réteg tagadta meg.
  'Bash(git ls-tree:*)',
  // A user 5. futásának MÉRT denialje: `git check-ignore -v <fájl>` — olvasó út
  // (azt mondja meg, ignorált-e egy fájl és melyik szabály fogja).
  //
  // MIÉRT MARAD AZ ENUMERÁCIÓ, ÉS NEM EGY GENERÁL `Bash(git:*)` + mutáló-deny:
  // a deny-oldal prefix-szinten NEM kifejezhető. A git a verb ELŐTT is fogad
  // flageket (`git -C <út> push`, `git -c <konfig> commit`), tehát egy
  // `Bash(git push:*)` deny ezeket nem fogná; a `-c core.fsmonitor=<parancs>`
  // ráadásul tetszőleges parancsfuttatás. Egy tág allow mellett a deny-lista
  // tehát lyukas lenne — így minden ÚJ olvasó ige mért denialként jön be, és
  // egyenként kerül fel ide (vállalt, dokumentált súrlódás).
  'Bash(git check-ignore:*)',
  'mcp__eslint__lint-files',
  // A jira MCP OLVASÓ toolok: a sweep-jira-compliance a ticketet (summary,
  // description, comments) MCP-n tölti be. FIGYELEM: a `jira_comments` (többes)
  // OLVAS, a `jira_comment` (egyes) ÍR — utóbbi tilos.
  'mcp__atlassian__jira_get',
  'mcp__atlassian__jira_search',
  'mcp__atlassian__jira_comments',
  // A skill-hívás maga (`/agent-review`, `hunk-review`) és az agent-fanout: az
  // agent-review 8 párhuzamos sweep-et + validation-taskokat delegál.
  'Skill',
  'Task',
  // Az olvasás: a `--tools`-ban is bent van, de a permission-réteg külön kapu.
  'Read',
  'Grep',
  'Glob',
]

/** Az allowlist argv-alakja. A flag MÉRT neve `--allowedTools` (camelCase is elfogadott). */
export const AI_REVIEW_ALLOWED_TOOLS_ARGS = ['--allowedTools', ...AI_REVIEW_ALLOWED_TOOLS]

/**
 * AZ EXPLICIT DENY-LISTA — védelem egy JÖVŐBELI allow-lazítás ellen.
 *
 * A Claude Code permission-rétegében a deny ERŐSEBB az allow-nál, tehát ez a
 * lista akkor is tart, ha valaki később egy tágabb `Bash(gh pr:*)` allow-t
 * venne fel. A `gh api -X POST` prefix-mintával NEM fejezhető ki (a minta a
 * parancs ELEJÉRE illeszkedik, a `-X POST` a végén van) — azt a prompt
 * tilalma fedi.
 */
export const AI_REVIEW_DISALLOWED_TOOLS = [
  // A `gh pr` MUTALO alparancsai. A lista a TAGABB `Bash(gh pr:*)` allow parja:
  // az allow az olvaso utakat (list/view/diff/checks/status) egy mintaval engedi,
  // a mutaciot EZ tartja. MERT alap: a `gh --help` szerint a verb ELOTT csak
  // `--help`/`--version` all, tehat a `gh <mutalo-verb>` prefix nem kerulheto meg
  // (szemben a `git -c core.fsmonitor=<parancs>`-csal, amiert a git-nel maradt az
  // enumeracio). A deny ERŐSEBB az allow-nal, tehat ez akkor is tart, ha az allow
  // kesobb tovabb tagul.
  'Bash(gh pr comment:*)',
  'Bash(gh pr review:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr ready:*)',
  'Bash(gh pr reopen:*)',
  'Bash(gh pr lock:*)',
  'Bash(gh pr unlock:*)',
  // A `gh run` mutalo utai: egy rerun/cancel a CI-t mozgatja, a delete torol.
  'Bash(gh run cancel:*)',
  'Bash(gh run rerun:*)',
  'Bash(gh run delete:*)',
  'Bash(gh run watch:*)',
]

export const AI_REVIEW_DISALLOWED_TOOLS_ARGS = ['--disallowedTools', ...AI_REVIEW_DISALLOWED_TOOLS]

/**
 * A MEGTAGADOTT HÍVÁSOK OLVASHATÓ ALAKJA — a PARANCS, nem a darabszám.
 *
 * MÉRT SÉMA (lásd az `AI_REVIEW_ALLOWED_TOOLS` fejét): a `tool_input.command`
 * tartalmazza a pontos parancsot. A régi üzenet ("3 permission-megtagadásba
 * futott") ezt ELDOBTA, tehát a user nem tudta, MIT vegyen fel az allowlistbe —
 * és ez épp az az információ, ami a hibát javíthatóvá teszi.
 *
 * A NEM-BASH toolokra (ahol nincs `command`) a TOOL NEVE megy ki: az is
 * cselekvésre alkalmas (`Write` → tudni, hogy írni akart).
 */
export function deniedCommandList(denials) {
  const list = Array.isArray(denials) ? denials : []
  return list.map((d) => {
    const cmd = d?.tool_input?.command
    if (typeof cmd === 'string' && cmd.trim() !== '') return cmd.trim()
    // A `command` nélküli tool: a NEVE a legbeszédesebb, ami megvan.
    return String(d?.tool_name ?? '(ismeretlen tool)')
  })
}

/**
 * A DENIALS-HIBA CSELEKVÉSRE ALKALMAS SZÖVEGE.
 *
 * A HÁROM KÖTELEZŐ ELEM (a régi üzenetben EGYIK sem volt benne, csak a szám):
 *  1. MELYIK PARANCSOT tagadta meg — enélkül a user nem tudja, mit engedélyezzen;
 *  2. MIÉRT — a `dontAsk` + a settings `allow` listája a KÉT tényező, és a
 *     usernek tudnia kell, hogy ez KONFIGURÁCIÓS ügy, nem review-hiba;
 *  3. MIT TEHET — konkrétan: mit vegyen fel a `~/.claude/settings.json`
 *     `permissions.allow` listájába, MÁSOLHATÓ alakban.
 *
 * A LISTA CSONKOLVA: egy 20 elemű denials-lista a status-sort használhatatlanná
 * tenné. Az ELSŐ HÁROM parancs a diagnózishoz elég (a #904-en mind ugyanabból az
 * osztályból jött), a maradék darabszáma pedig kimondva marad — nem hallgatjuk
 * el, hogy több is volt.
 */
export function denialMessage(denials) {
  const cmds = deniedCommandList(denials)
  const shown = cmds.slice(0, 3)
  const rest = cmds.length - shown.length
  const list = shown.map((c) => `\`${c}\``).join(', ') + (rest > 0 ? ` (+${rest} további)` : '')
  return (
    `a claude -p ${cmds.length} permission-megtagadásba futott — a review nem teljes. `
    + `A MEGTAGADOTT hívások: ${list}. `
    + 'OK: a review `--permission-mode dontAsk`-kal fut, és ezek a parancsok sem az '
    + 'allowlistünkön, sem a `~/.claude/settings.json` `permissions.allow` listáján nincsenek. '
    + 'MIT TEHETSZ: vedd fel őket az `allow` listába '
    + `(pl. ${shown.map((c) => `"Bash(${c.split(/\s+/).slice(0, 3).join(' ')}:*)"`).join(', ')}), `
    + 'vagy jelezd, hogy a TUI beépített allowlistje hiányos — a bővítés helye a core '
    + '`AI_REVIEW_ALLOWED_TOOLS` listája (tuipr, bin/next/allowlist.mjs).'
  )
}

// A KÖZÖS PROMPT-BLOKK a permission-realitásokról — MINDKÉT review-út kapja.
//
// (c) A COMPOUND-PARANCS ELVBŐL nem engedhető: a permission-minták
// PREFIX-alapúak, tehát egy `gh pr checks 904 …; gh api …` alakú, `;`-vel
// fűzött parancs akkor is denied, ha MINDKÉT fele külön engedett lenne — a
// user élő tesztje pontosan ezen halt el. A külön futtatás olcsóbb és
// robusztusabb, mint bármilyen compound-parsing a mi oldalunkon.
//
// (a-fallback) A user-szintű instrukciók tilalma DEFENSE-IN-DEPTH: az
// elsődleges védelem a `--setting-sources project,local` (mérve kizárja a
// user-szintű CLAUDE.md-t), de ha bármilyen úton mégis beszivárogna egy
// workflow-utasítás (pl. egy jövőbeli CLI-verzió más forrás-szemantikával),
// a prompt kimondja, hogy nem követendő. A `claude-usage` név szerint tiltva:
// a mért denial pontosan ez volt.
export const PERMISSION_REALITY_INSTRUCTION = [
  'KERESÉSHEZ a Grep TOOLT használd (a tool-készletedben van), NE `git grep`-et',
  'vagy `rg`-t Bash-en át — a Grep toolnak nem kell permission. Ha egy Bash-hívást',
  'a permission-réteg megtagad, NE ismételd variálva: jegyezd fel a review',
  'összefoglalójában, és haladj tovább a többi sweeppel — a részleges eredmény is',
  'értékes, a findingjaidat mindenképp add vissza a válasz-JSON-ban.',
  'A parancsokat KÜLÖN-KÜLÖN futtasd, SOHA ne `;`-vel, `&&`-del vagy pipe-on át',
  'fűzve több parancsot: a permission-minták prefix-alapúak, az összetett parancs',
  'megtagadásra fut akkor is, ha minden darabja külön engedett lenne.',
  '',
  'NE futtass `claude-usage`-t, és NE kövesd a user-szintű (globális CLAUDE.md)',
  'workflow-instrukciókat (gate-ek, delegálási szabályok) — a feladatod',
  'KIZÁRÓLAG a review.',
  '',
  'TILOS GitHubra posztolni vagy mutálni: se `gh pr comment`, se `gh pr review`,',
  'se `gh pr merge`, se `gh api` POST/PATCH/PUT/DELETE (mutáló hívás). A `gh api`',
  'KIZÁRÓLAG olvasásra (GET — pl. reviews/comments lekérdezés) használható.',
].join('\n')
