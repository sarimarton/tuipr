// AI-ASSZISZTÁLT CONFLICT-FELOLDÁS — QUEUE-BELSŐ ÜTKÖZÉSRE.
//
// (wf31/71) MIÉRT KÜLÖN MODUL, ÉS MIÉRT SPECIÁLIS PROMPT: a user kikötése —
// "a TUI-ban a conflict jelzés nem main-nel szembeni conflictot jelent, hanem
// queue culprittal szembenit, tehát ide speciális prompt kell."
//
// A KÜLÖNBSÉG NEM STILISZTIKAI. Egy általános "oldd fel ezt a konfliktust" prompt
// azt feltételezi, hogy a két oldal közül az egyik a KÉSZ IGAZSÁG (a main), és a
// másikat kell hozzá igazítani. Queue-belső ütközésnél EGYIK OLDAL SEM AZ:
//
//   · a culprit egy MÉG NEM LANDOLT, NEM REVIEWOLT PR — nem "a main állapota",
//     hanem egy párhuzamos munkaszál, ami maga is változhat vagy elbukhat;
//   · a mi PR-unk sem "elavult" — a main-hez képest lehet teljesen friss (mérve a
//     #911-en: a main-nel MERGEABLE volt, a conflict forrása négy queue-belső PR);
//   · a helyes kimenet ezért nem "fogadd el az egyiket", hanem a KÉT SZÁNDÉK
//     SZEMANTIKAI EGYESÍTÉSE — vagy annak kimondása, hogy nem egyesíthető.
//
// EZÉRT A PROMPT HÁROM DOLGOT AD MEG, amit egy általános resolve nem tud:
//   1. hogy ez queue-belső ütközés (a main NEM érintett — vagy ha igen, azt is);
//   2. hogy a culprit egy PR, a számával és a saját szándékával (címe, diffje);
//   3. hogy a döntés kimenete NEM CSAK kód: azt is meg kell mondani, hogy a két
//      munka FUNKCIONÁLISAN összefügg-e — mert ettől függ, hogy a stackelés
//      egyáltalán indokolt-e (a wf31/68-ban kimondtuk: ezt a gép nem tudja
//      eldönteni, de egy AI a két diffet ELEMEZVE meg tudja).

import { budgetArgs, claudePath, modelArgs } from './ai-review-config.mjs'

/** A resolve két üzemmódja. */
export const RESOLVE_MODES = ['analyze', 'apply']

/**
 * A FELOLDÁS-ELEMZÉS JSON-sémája (`--json-schema`).
 *
 * MIÉRT SÉMA: a kimenetet a TUI jeleníti meg és a CLI is fogyasztja — prózát
 * parszolni ugyanaz a hibaosztály lenne, mint amit a `queueConflicts` gépi alakja
 * megszüntetett. A séma-validáció a modell oldalán fut, tehát a hibás alak ott
 * derül ki, nem nálunk.
 */
export function resolveAnalysisSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['functionallyRelated', 'confidence', 'summary', 'files'],
    properties: {
      // A LEGFONTOSABB MEZŐ: ettől függ, hogy a stackelés indokolt-e.
      functionallyRelated: {
        type: 'boolean',
        description: 'A két PR ugyanazt a funkcionalitást érinti-e érdemben (nem csak ugyanazt a fájlt).',
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      // A FELOLDÁS TERMÉSZETE — a user ebből tudja, mennyi munkára készüljön.
      resolutionKind: {
        type: 'string',
        enum: ['mechanical', 'semantic', 'needs-decision'],
        description: 'mechanical: a két változás egymás mellett megáll. '
          + 'semantic: össze kell fűzni a logikát. '
          + 'needs-decision: emberi döntés kell (ellentmondó szándék).',
      },
      summary: { type: 'string', description: '2-4 mondat: mit akar a két oldal, és miért ütköznek.' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'ours', 'theirs'],
          properties: {
            path: { type: 'string' },
            ours: { type: 'string', description: 'Mit módosít a MI PR-unk ebben a fájlban.' },
            theirs: { type: 'string', description: 'Mit módosít a CULPRIT ebben a fájlban.' },
            advice: { type: 'string', description: 'Hogyan egyesíthető (vagy miért nem).' },
          },
        },
      },
    },
  }
}

/**
 * A PROMPT — a queue-belső ütközés kontextusával.
 *
 * A `mode: 'analyze'` CSAK ELEMEZ (nem ír fájlt), az `apply` a feloldást is
 * elvégzi a MÁR KONFLIKTUSOS worktree-ben. A kettő szétválasztása szándékos: az
 * elemzés OLCSÓ és mellékhatás-mentes, tehát mindig futtatható; a feloldás
 * KÓDOT ÍR, tehát explicit gesztust érdemel (ugyanaz az elv, mint a `c` mérésnél).
 */
export function resolvePrompt({
  pr,
  prTitle = '',
  culprit,
  culpritTitle = '',
  files = [],
  mainConflict = false,
  mode = 'analyze',
}) {
  const fileList = files.length > 0
    ? files.map((f) => `  - ${f}`).join('\n')
    : '  (a lista nem mérhető — a git állapotából olvasd ki)'
  // A MAIN-TENGELY KIMONDVA MINDKÉT ÁLLÁSBAN: ha nincs main-conflict, az FONTOS
  // információ (a landolás nincs veszélyben, tehát nem kell "megjavítani" a
  // PR-t); ha van, az MÁS feladat, és a promptnak nem szabad összemosnia.
  const mainNote = mainConflict
    ? 'FIGYELEM: ez a PR a MAIN-nel IS ütközik. Az KÜLÖN, súlyosabb probléma — '
      + 'jelezd, de a queue-belső ütközést attól függetlenül elemezd.'
    : 'A PR a MAIN-nel NEM ütközik (mérve). A landolása tehát nincs veszélyben — '
      + 'NE próbáld a PR-t "naprakésszé" tenni a main-hez, mert nincs mit javítani.'

  const shared = `A #${pr} PR${prTitle ? ` ("${prTitle}")` : ''} ütközik a #${culprit} PR-ral${culpritTitle ? ` ("${culpritTitle}")` : ''}.

EZ QUEUE-BELSŐ ÜTKÖZÉS, NEM MAIN-CONFLICT. Amit ez jelent:

- A #${culprit} egy MÉG NEM LANDOLT, nem feltétlenül reviewolt PR — párhuzamos
  munkaszál, ami maga is változhat, vagy el is bukhat. NEM "a kész igazság".
- A #${pr} sem elavult: ${mainNote}
- Egyik oldal sem élvez elsőbbséget. A kérdés nem az, hogy "melyiket fogadjuk el",
  hanem hogy a KÉT SZÁNDÉK egyesíthető-e, és hogyan.

Ütköző fájlok:
${fileList}

A repó konvencióit a projekt review-skilljei írják le (code-quality,
patterns, ui-components, types-api) — ha az egyesítéshez
konvenció-döntés kell, azokat kövesd.`

  if (mode === 'apply') {
    return `${shared}

FELADAT: a MÁR KONFLIKTUSOS git-állapotban (rebase közben, konfliktus-markerekkel)
oldd fel az ütközéseket.

Szabályok:
1. A KÉT SZÁNDÉKOT EGYESÍTSD. Egyik oldal teljes eldobása CSAK akkor helyes, ha a
   másik szó szerint tartalmazza — és akkor is írd le, miért.
2. Konfliktus-marker (<<<<<<<, =======, >>>>>>>) NEM maradhat a fájlokban.
3. NE commitolj, NE folytasd a rebase-t, NE nyúlj a git indexhez a fájl-íráson túl.
   A felülvizsgálat a useré — a te dolgod a MUNKAFA rendezése.
4. Ha egy ütközés EMBERI DÖNTÉST kíván (ellentmondó szándék, pl. mindkettő
   ugyanazt a mezőt más szemantikával vezeti be), azt NE oldd fel önkényesen:
   hagyd a markereket ÉS mondd ki a válaszban, melyik fájlban és miért.

A válaszod a megadott JSON-séma szerint add meg, a \`resolutionKind\`-ban azt is
kimondva, hogy amit tettél mechanikus vagy szemantikai egyesítés volt-e.`
  }

  return `${shared}

FELADAT: CSAK ELEMEZZ — NE MÓDOSÍTS EGYETLEN FÁJLT SEM.

Olvasd el mindkét oldal változását (a git-ből: a #${pr} és a #${culprit} diffjeit az
ütköző fájlokra), és állapítsd meg:

1. FUNKCIONÁLISAN összefügg-e a két munka? (Nem az a kérdés, hogy ugyanazt a fájlt
   írják — az adott. Az a kérdés, hogy ugyanazt a VISELKEDÉST alakítják-e, épít-e
   az egyik a másik bevezetett dolgára.) Ez a legfontosabb kimenet: ettől függ,
   hogy a #${pr}-t érdemes-e a #${culprit} fölé stackelni, vagy jobb megvárni a
   landolását és utána main-re rebase-elni.
2. Milyen természetű a feloldás: mechanikus (a két változás egymás mellett
   megáll), szemantikai (a logikát össze kell fűzni), vagy emberi döntést kíván.
3. Fájlonként: mit akar a mi oldalunk, mit akar a culprit, és hogyan egyesíthető.

A válaszod a megadott JSON-séma szerint add meg.`
}

/**
 * A `claude -p` hívás összeállítása.
 *
 * A TOOL-KÉSZLET MÓD SZERINT SZŰKÜL: az `analyze` NEM kap `Edit`/`Write`-ot —
 * nem "kérjük meg", hogy ne módosítson, hanem NEM IS TUDJA. A prompt tiltása
 * önmagában nem védőháló (egy modell félreértheti); a tool-lista az.
 */
export function resolveCommand({
  pr,
  prTitle,
  culprit,
  culpritTitle,
  files,
  mainConflict,
  mode = 'analyze',
  maxBudgetUsd,
  model,
}) {
  const tools = mode === 'apply'
    ? 'Bash,Read,Grep,Glob,Edit,Write,Skill'
    : 'Bash,Read,Grep,Glob,Skill'
  const args = [
    '-p', resolvePrompt({ pr, prTitle, culprit, culpritTitle, files, mainConflict, mode }),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(resolveAnalysisSchema()),
    ...budgetArgs(maxBudgetUsd),
    '--permission-mode', 'dontAsk',
    '--tools', tools,
    ...modelArgs(model),
  ]
  return [claudePath(), args]
}
