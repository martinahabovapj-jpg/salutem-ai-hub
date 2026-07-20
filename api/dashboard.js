// api/dashboard.js — Vercel serverless funkce (v2 — AI agenda dle migrovaného Freela)
// Čte VÝHRADNĚ 4 to-do listy migrovaného projektu 561017 a vrací parsovaný dashboard.
// Přihlášení: FREELO_EMAIL + FREELO_API_TOKEN (Basic auth) v env proměnných Vercelu.
//
// Odpověď: { hlavicka, dlazdice, sekce: { hotovo[], aktualne[], pripraveno[], backlog[] }, log[], generatedAt }
// Karta obsahuje jen pole, která web zobrazuje (FÁZE, PŘEKÁŽKA, DALŠÍ KROK, skóre se NEposílají — A4).

const FREELO_BASE = 'https://api.freelo.io/v1';
const TOKEN = process.env.FREELO_API_TOKEN;
const EMAIL = process.env.FREELO_EMAIL;

// 4 zdrojové listy (ID z migrace-report.md). `stem` = kmen názvu pro pojistku shody názvů.
const LISTS = [
  { key: 'prod', id: 1946848, vetev: 'produkcni',  stem: 'produkcni vetev' },
  { key: 'edu',  id: 1946850, vetev: 'vzdelavaci', stem: 'vzdelavaci vetev' },
  { key: 'comp', id: 1931437, vetev: 'compliance', stem: 'compliance' },
  { key: 'udrz', id: 1943888, vetev: 'produkcni',  stem: 'udrzovani' }, // Udržování = vždy produkční větev (1b)
];

// ---------- pomocné funkce ----------

// odstraní diakritiku, malá písmena, sjednotí mezery
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---- Tolerantní parser šablony v2 (ručně editované HTML z Freela) ----
// Freelo editor generuje spoustu variant (<b>/<strong>, dvojtečka uvnitř i vně tučnosti,
// <div>/<br> místo <p>, &nbsp;, mezery kolem dvojtečky). Proto: HTML → řádky čistého textu
// → na každém řádku hledej „KLÍČ : hodnota" proti seznamu známých klíčů. Robustnější než regex nad HTML.

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, m => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

// <br>, konce bloků a <hr> → nový řádek; ostatní tagy pryč; entity dekódovat
function htmlToLines(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<hr\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).split('\n');
}

// zjednodušený náhled popisu (pro log)
function stripToText(html) {
  return htmlToLines(html).join(' ').replace(/\s+/g, ' ').trim();
}

// známé klíče šablony v2 (normalizované: bez diakritiky, VELKÁ, sjednocené mezery)
const KNOWN_KEYS = [
  'ZADAVATEL', 'PROBLEM V CISLECH', 'POPIS RESENI', 'PRINOS KC/ROK', 'TYP PRINOSU',
  'USPORA HODIN/ROK', 'INVESTICE KC', 'NAVRATNOST', 'OVERENO', 'FAZE',
  'ZAPOJENI KOLEGOVE', 'PREKAZKA', 'DALSI KROK', 'CEKA NA', 'CHYBI PODKLADY',
  'VYSLEDEK POPIS', 'CITAT', 'V PROVOZU OD',
];

// na každém řádku: text před první dvojtečkou = klíč (porovnat bez diakritiky/case), zbytek = hodnota
function parseFields(html) {
  const fields = {};
  for (const line of htmlToLines(html)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = norm(line.slice(0, idx)).toUpperCase();     // "PŘÍNOS KČ/ROK :" -> "PRINOS KC/ROK"
    if (KNOWN_KEYS.indexOf(key) === -1) continue;
    if (fields[key] !== undefined) continue;                // první výskyt vyhrává (v2 je nad <hr>)
    fields[key] = line.slice(idx + 1).replace(/\s+/g, ' ').trim();
  }
  return fields;
}

// v1 obsah pod <hr> ignoruj JEN když se nad ním našlo aspoň jedno pole;
// jinak (ručně založený úkol bez <hr> / <hr> jinde) parsuj celý popis
function parseTemplate(html) {
  if (!html) return {};
  const aboveHr = String(html).split(/<hr\s*\/?>/i)[0];
  const fields = parseFields(aboveHr);
  return Object.keys(fields).length > 0 ? fields : parseFields(html);
}

// zvedne hodnotu pole podle normalizovaného klíče
function field(fields, key) {
  return (fields[key] || '').trim();
}

// "480 000 Kč" / "1,2 mil" / "640000" -> číslo (Kč). Prázdné -> null.
function parseKc(raw) {
  if (!raw) return null;
  let s = norm(raw).replace(/kc|,-/g, '').trim();
  if (!s) return null;
  const mil = s.match(/([\d\s.,]+)\s*mil/);
  if (mil) return Math.round(toNum(mil[1]) * 1e6);
  const tis = s.match(/([\d\s.,]+)\s*tis/);
  if (tis) return Math.round(toNum(tis[1]) * 1e3);
  const n = toNum(s);
  return isNaN(n) ? null : Math.round(n);
}

function toNum(x) {
  let t = String(x).replace(/[^\d.,]/g, '');
  if (t.indexOf(',') > -1 && t.indexOf('.') > -1) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.indexOf(',') > -1) t = t.replace(',', '.');
  return parseFloat(t);
}

// české zkrácené formátování: 1,2 mil. Kč · 640 tis. Kč
function formatKc(n) {
  if (n == null || isNaN(n) || n === 0) return null;
  if (n >= 1e6) {
    let s = (n / 1e6).toFixed(1).replace('.', ',');
    s = s.replace(',0', '');
    return s + ' mil. Kč';
  }
  if (n >= 1000) return Math.round(n / 1000) + ' tis. Kč';
  return Math.round(n) + ' Kč';
}

// OVĚŘENO: "ano…" -> true
function isOvereno(raw) {
  return /^ano/.test(norm(raw));
}

// TYP PŘÍNOSU -> kategorie: 'vynos' | 'naklady' | null
function typKategorie(raw) {
  const t = norm(raw);
  if (!t) return null;
  if (t.indexOf('vynos') > -1) return 'vynos';
  if (t.indexOf('cas') > -1 || t.indexOf('uspora') > -1 ||
      t.indexOf('vyhnuta') > -1 || t.indexOf('risk') > -1) return 'naklady';
  return null;
}

// pipeline štítek z pole labels (ostatní štítky typu Obchod/Customer Care ignorujeme)
function pipelineLabel(labels) {
  const names = (labels || []).map(l => norm(l.name));
  if (names.some(n => n.indexOf('nova poptavka') > -1)) return 'nova-poptavka';
  if (names.some(n => n.indexOf('testovacim provozu') > -1)) return 'testovaci-provoz';
  if (names.some(n => n === 'in process' || n.indexOf('in process') > -1)) return 'in-process';
  if (names.some(n => n.indexOf('on hold') > -1 || n.indexOf('onhold') > -1)) return 'onhold';
  if (names.some(n => n.indexOf('backlog') > -1)) return 'backlog';
  return null;
}

async function freeloGet(path) {
  const res = await fetch(`${FREELO_BASE}${path}`, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64'),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Freelo API ${res.status} @ ${path}`);
  return res.json();
}

// všechny úkoly listu (vč. podúkolů), s pagingem
async function fetchAllTasks(listId) {
  let page = 0, all = [], total = Infinity;
  do {
    const r = await freeloGet(`/all-tasks?tasklists_ids%5B%5D=${listId}&page=${page}`);
    const tasks = (r.data && r.data.tasks) || [];
    all = all.concat(tasks);
    total = r.total || all.length;
    page++;
    if (tasks.length === 0) break;
  } while (all.length < total);
  return all;
}

// spustí promises po dávkách (concurrency cap)
async function inChunks(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...await Promise.all(chunk.map(fn)));
  }
  return out;
}

// je šablona v2 vyplněná? (F4 revize v4 — platí pro VŠECHNY listy)
// „vyplněná" = pole POPIS ŘEŠENÍ nebo ZADAVATEL má neprázdnou hodnotu (field() ořezává bílé znaky)
function hasTemplate(f) {
  return !!(field(f, 'POPIS RESENI') || field(f, 'ZADAVATEL'));
}

// sestaví kartu use casu (jen zobrazovaná pole + datová příprava pro E1)
function buildCard(task, list, sekce, f) {
  const prinosRaw = parseKc(field(f, 'PRINOS KC/ROK'));
  const investRaw = parseKc(field(f, 'INVESTICE KC'));
  return {
    id: task.id,
    vetev: list.vetev,
    sekce,
    nazev: (task.name || '').replace(/\[dashboard\]|\[interní\]/gi, '').trim(),
    zadavatel: field(f, 'ZADAVATEL'),
    problem: field(f, 'PROBLEM V CISLECH'),
    reseni: field(f, 'POPIS RESENI'),
    prinosKc: prinosRaw,
    prinosText: formatKc(prinosRaw),
    typPrinosu: field(f, 'TYP PRINOSU'),
    investiceKc: investRaw,
    investiceText: formatKc(investRaw),
    navratnost: field(f, 'NAVRATNOST'),
    overeno: isOvereno(field(f, 'OVERENO')),
    // hotovo — patička:
    vysledek: field(f, 'VYSLEDEK POPIS'),
    citat: field(f, 'CITAT'),
    vProvozuOd: field(f, 'V PROVOZU OD'),
    dateFinished: task.date_finished || null,
    // backlog — patička:
    chybiPodklady: field(f, 'CHYBI PODKLADY'),
    // E1 datová příprava (zatím se nezobrazuje):
    cekaNa: field(f, 'CEKA NA'),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800'); // cache 15 min

  if (!TOKEN || !EMAIL) {
    return res.status(500).json({ error: 'FREELO_API_TOKEN nebo FREELO_EMAIL není nastaven' });
  }

  try {
    const log = [];

    // 1) načti všechny listy + pojistka shody názvů (při neshodě chyba, ne prázdná data)
    const lists = await Promise.all(LISTS.map(async (L) => {
      const meta = await freeloGet(`/tasklist/${L.id}`);
      if (norm(meta.name).indexOf(L.stem) === -1) {
        throw new Error(`Neshoda názvu listu ${L.id}: očekáváno „${L.stem}", ve Freelu „${meta.name}"`);
      }
      const tasks = await fetchAllTasks(L.id);
      return { ...L, tasks };
    }));

    // 2) roztřiď top-level úkoly do sekcí
    const sekce = { hotovo: [], aktualne: [], pripraveno: [], backlog: [] };
    const toLoad = []; // { task, list, sekce }

    for (const L of lists) {
      const top = L.tasks.filter(t => !t.parent_task_id);
      const children = L.tasks.filter(t => t.parent_task_id);

      for (const t of top) {
        const pl = pipelineLabel(t.labels);
        const isFinished = (t.state && t.state.id) === 5;
        const kids = children.filter(c => c.parent_task_id === t.id);
        const hasActiveSub = kids.some(c => (c.state && c.state.id) !== 5 && (c.worker || c.due_date));

        let target = null;
        if (L.key === 'udrz') {
          target = 'hotovo'; // šablonu ověříme až po načtení popisu (F4)
        } else if ((L.key === 'edu' || L.key === 'comp') && isFinished) {
          target = 'hotovo';
        } else if (pl === 'nova-poptavka') {
          log.push(`skryto (nová poptávka): [${t.id}] ${t.name}`);
        } else if (!pl) {
          log.push(`skryto (bez pipeline štítku, mimo Udržování): [${t.id}] ${t.name}`);
        } else if (pl === 'backlog') {
          target = 'backlog';
        } else if (pl === 'testovaci-provoz') {
          target = 'aktualne';
        } else if (pl === 'in-process') {
          target = hasActiveSub ? 'aktualne' : 'pripraveno';
        } else if (pl === 'onhold') {
          target = 'pripraveno';
        }

        if (target) toLoad.push({ task: t, list: L, sekce: target });
      }
    }

    // 3) načti popisy (v2 šablony) jen u zobrazovaných úkolů, po dávkách
    const cards = await inChunks(toLoad, 6, async ({ task, list, sekce: target }) => {
      let f = {}, preview = '', hadDesc = false;
      try {
        const detail = await freeloGet(`/task/${task.id}`);
        const desc = (detail.comments || []).find(c => c.is_description);
        if (desc && desc.content) {
          hadDesc = true;
          f = parseTemplate(desc.content);
          preview = stripToText(desc.content).slice(0, 150);
        }
      } catch (e) {
        log.push(`popis se nepodařilo načíst: [${task.id}] ${task.name}`);
      }
      return { task, list, target, f, preview, hadDesc };
    });

    // 4) zařaď karty — filtr šablony platí pro VŠECHNY listy (F4 revize v4)
    for (const { task, list, target, f, preview, hadDesc } of cards) {
      if (!hasTemplate(f)) {
        if (!hadDesc) {
          log.push(`skryto (popis prázdný): [${task.id}] ${task.name}`);
        } else if (Object.keys(f).length === 0) {
          log.push(`skryto (popis existuje, ale nerozpoznáno žádné pole): [${task.id}] ${task.name} — „${preview}"`);
        } else {
          log.push(`skryto (šablona bez POPIS ŘEŠENÍ/ZADAVATEL — F4): [${task.id}] ${task.name}`);
        }
        continue;
      }
      sekce[target].push(buildCard(task, list, target, f));
    }

    // 5) řazení: hotovo dle V PROVOZU OD / date_finished sestupně; ostatní dle přínosu sestupně
    const dateVal = (c) => {
      const d = Date.parse(c.vProvozuOd) || Date.parse(c.dateFinished);
      return isNaN(d) ? -Infinity : d;
    };
    sekce.hotovo.sort((a, b) => dateVal(b) - dateVal(a));
    ['aktualne', 'pripraveno', 'backlog'].forEach(s => {
      sekce[s].sort((a, b) => (b.prinosKc || -Infinity) - (a.prinosKc || -Infinity));
    });

    // 6) finanční hlavička (B3) — agregace přes všechny zobrazené karty
    let vynos = 0, vynosOv = 0, naklady = 0, nakladyOv = 0, investovano = 0;
    const all = [...sekce.hotovo, ...sekce.aktualne, ...sekce.pripraveno, ...sekce.backlog];
    for (const c of all) {
      if (c.prinosKc) {
        const kat = typKategorie(c.typPrinosu);
        if (kat === 'vynos') { vynos += c.prinosKc; if (c.overeno) vynosOv += c.prinosKc; }
        else if (kat === 'naklady') { naklady += c.prinosKc; if (c.overeno) nakladyOv += c.prinosKc; }
      }
    }
    for (const c of [...sekce.hotovo, ...sekce.aktualne]) {
      if (c.investiceKc) investovano += c.investiceKc;
    }

    const overenoDovetek = (ov) => (ov > 0 ? 'z toho ověřeno ' + formatKc(ov) : 'odhad');

    const hlavicka = {
      noveVynosy:      { text: formatKc(vynos) || '—',   dovetek: overenoDovetek(vynosOv) },
      usporeneNaklady: { text: formatKc(naklady) || '—', dovetek: overenoDovetek(nakladyOv) },
      investovano:     { text: formatKc(investovano) || '—' },
    };

    const dlazdice = {
      hotovo: sekce.hotovo.length,
      aktualne: sekce.aktualne.length,
      pripraveno: sekce.pripraveno.length,
      backlog: sekce.backlog.length,
    };

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      hlavicka,
      dlazdice,
      sekce,
      log,
    });
  } catch (err) {
    console.error('Dashboard API error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Pojmenované exporty pro jednotkové testy parseru (default handler výše zůstává funkcí Vercelu).
export { parseTemplate, parseFields, hasTemplate, htmlToLines, stripToText, field, norm, KNOWN_KEYS };
