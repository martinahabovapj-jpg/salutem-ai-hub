// api/dashboard.js — Vercel serverless funkce
// Tahá data z Freelo API a vrátí parsovaný dashboard JSON
// Token je uložen v FREELO_API_TOKEN environment variable ve Vercelu

const FREELO_BASE = 'https://api.freelo.io/v1';
const TOKEN = process.env.FREELO_API_TOKEN;
const EMAIL = process.env.FREELO_EMAIL; // tvůj přihlašovací email do Freela

// ID hlavních use casů (task ID → název)
// To-do listy které se NEZOBRAZUJÍ na dashboardu
const EXCLUDED_LIST_IDS = [1883045, 1717295]; // AI Hub & provoz týmu, Freelo formulář + ukolník PŠ

const USE_CASES = [
  { taskId: 29993565, listId: 1883031, name: 'Rychlejší práce s emaily',         level: 'l3', direction: 'dovnitř' },
  { taskId: 29993922, listId: 1883032, name: 'Přehled z 20 Teams skupin',        level: 'l3', direction: 'dovnitř' },
  { taskId: 29993681, listId: 1883033, name: 'Zadávej úkoly hlasem',             level: 'l3', direction: 'dovnitř' },
  { taskId: 29993796, listId: 1883034, name: 'Z porady rovnou úkoly',            level: 'l3', direction: 'dovnitř' },
  { taskId: 29993839, listId: 1883036, name: 'Rychlejší analýza smluv',          level: 'l3', direction: 'dovnitř' },
  { taskId: 29993878, listId: 1883037, name: 'Chytřejší práce s tabulkami',      level: 'l3', direction: 'dovnitř' },
  { taskId: 29993913, listId: 1883038, name: 'Méně manuálního přepisování',      level: 'l2', direction: 'obojí'   },
  { taskId: 29993914, listId: 1883039, name: 'Z nákupu do prodeje rychleji',     level: 'l2', direction: 'obojí'   },
  { taskId: null,     listId: 1883040, name: 'Týmové piloty na míru',            level: 'l2', direction: 'obojí', multiTask: true },
  { taskId: 29993915, listId: 1883041, name: 'Upozornění na změny v katastru',   level: 'l1', direction: 'ven'     },
  { taskId: 29993917, listId: 1883042, name: 'Predikce Cash Flow',               level: 'l1', direction: 'dovnitř' },
  { taskId: 29993918, listId: 1883043, name: 'Jeden zdroj pravdy dat',           level: 'l0', direction: 'dovnitř' },
  { taskId: 29993920, listId: 1883044, name: 'Jeden report místo čtyř',          level: 'l0', direction: 'dovnitř' },
];

// Parsuje HTML popis šablony na strukturovaný objekt
// Formát: <p><strong>KLÍČ:</strong> hodnota</p>
function parseDescription(html) {
  if (!html) return {};
  const fields = {};
  // Přesný pattern pro formát Freela: <p><strong>KLÍČ:</strong> hodnota</p>
  const pattern = /<p><strong>([^<]+):<\/strong>\s*(.*?)<\/p>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const rawKey = match[1].trim();
    const value = match[2].replace(/<[^>]+>/g, '').trim();
    // Normalizuj klíč — odstraň diakritiku, nahraď mezery podtržítkem
    const key = rawKey.toUpperCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '_');
    fields[key] = value;
  }
  return fields;
}

// Freelo API GET helper
async function freeloGet(path) {
  const res = await fetch(`${FREELO_BASE}${path}`, {
    headers: {
      // Freelo používá HTTP Basic auth: email + API token jako heslo
      'Authorization': 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64'),
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Freelo API error ${res.status} for ${path}`);
  return res.json();
}

// Zpracuje jeden hlavní use case task
async function processTask(taskId) {
  const data = await freeloGet(`/task/${taskId}`);

  // Najdi description komentář (is_description: true)
  const descComment = (data.comments || []).find(c => c.is_description);
  const fields = descComment ? parseDescription(descComment.content) : {};

  // Subtasky — načti zvlášť
  let subtasks = [];
  if (data.count_subtasks > 0) {
    const subData = await freeloGet(`/task/${taskId}/subtasks`);
    // Freelo vrací data.subtasks, ne items
    const subList = (subData.data && subData.data.subtasks) ? subData.data.subtasks : [];
    subtasks = subList
      .filter(s => {
        const name = s.name || '';
        const isDashboard = name.includes('[dashboard]') ||
          /pilot s|schůzka s|sezení s|rozhovor s/i.test(name);
        const isIntern = name.includes('[interní]') ||
          /technická příprava|komunikační příprava|checklist|interní příprava|pilotní obsah|interní pracovní systém|datová příprava/i.test(name);
        return isDashboard && !isIntern;
      })
      .map(s => ({
        id: s.task_id,
        name: s.name.replace('[dashboard]', '').trim(),
        status: s.state?.id === 5 ? 'finished' : 'active',
        dueDate: s.due_date || null,
        finished: s.state?.id === 5,
        worker: s.worker?.fullname || null,
      }));
  }

  // Určí status z šablony nebo Freelo state
  const statusMap = {
    'v běhu': 'inprocess',
    'hotovo': 'done',
    'pozastaveno': 'paused',
    'plánováno': 'planned',
  };
  // Zkus různé varianty klíče STATUS po normalizaci
  const rawStatus = (
    fields['STATUS'] ||
    fields['STAV'] ||
    fields['STATUS_'] ||
    ''
  ).toLowerCase().trim();

  // Fallback logika: pokud STATUS není vyplněn, odvoď ze stavu úkolu a podúkolů
  let status = statusMap[rawStatus];
  if (!status) {
    if (data.state?.id === 5) {
      status = 'done';
    } else {
      // "v běhu" pokud má podúkol s řešitelem nebo termínem (načteme níže)
      status = null; // doplníme po načtení subtasků
    }
  }

  // Pokud status nebyl určen ze šablony, odvoď z podúkolů
  if (!status) {
    const hasActiveSubtaskWithDateOrWorker = subtasks.some(s =>
      !s.finished && (s.dueDate || s.worker)
    );
    status = hasActiveSubtaskWithDateOrWorker ? 'inprocess' : 'planned';
  }

  return {
    taskId,
    name: fields['NAZEV'] || data.name,
    popis: fields['POPIS'] || '',
    uroven: fields['UROVEN'] || '',
    status,
    datumZahajeni: fields['DATUM_ZAHAJENI'] || '',
    datumDokonceni: fields['DATUM_DOKONCENI'] || data.date_finished || '',
    dateFinished: data.date_finished || null,
    zapojeniKolegove: fields['ZAPOJENI_KOLEGOVE']
      ? fields['ZAPOJENI_KOLEGOVE'].split(',').map(s => s.trim()).filter(Boolean)
      : [],
    usporaHodin: parseFloat(fields['USPORA_HODIN']) || null,  // celkem h/rok za celý tým
    usporaKc: parseFloat(fields['USPORA_KC']) || null,
    vysledekPopis: fields['VYSLEDEK_POPIS'] || '',
    citat: fields['CITAT'] || '',
    subtasks,
  };
}

// Zpracuje Týmové piloty na míru jako JEDNU kartu s podúkoly z celého to-do listu
async function processListAsOneCard(uc) {
  const data = await freeloGet(`/tasklist/${uc.listId}`);
  const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];

  // Všechny top-level úkoly v listu = piloty = zobrazíme jako subtasky
  const topTasks = rawTasks.filter(t => !t.parent_task_id);

  // Filtruj jen aktivní (ne hotové) s termínem nebo bez
  const subtasks = topTasks
    .filter(t => {
      const isIntern = /technická příprava|komunikační příprava|checklist|interní příprava/i.test(t.name || '');
      return !isIntern;
    })
    .map(t => ({
      id: t.id,
      name: t.name,
      status: t.state?.id === 5 ? 'finished' : 'active',
      dueDate: t.due_date || null,
      finished: t.state?.id === 5,
    }));

  // "v běhu" pokud má alespoň jeden pilot s termínem nebo řešitelem
  const hasActiveWithDateOrWorker = subtasks.some(s => !s.finished && (s.dueDate || s.worker));
  const listStatus = hasActiveWithDateOrWorker ? 'inprocess' : 'planned';

  return {
    taskId: null,
    name: uc.name,
    popis: `Aktivní piloty na míru pro různá oddělení — Customer Care, Pronájmy, Marketing, HR/IT a další.`,
    uroven: uc.level,
    status: listStatus,
    direction: uc.direction,
    datumZahajeni: '',
    datumDokonceni: '',
    dateFinished: null,
    zapojeniKolegove: [],
    usporaHodin: null,
    usporaKc: null,
    vysledekPopis: '',
    citat: '',
    subtasks,
  };
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800'); // cache 15 minut

  if (!TOKEN || !EMAIL) {
    return res.status(500).json({ error: 'FREELO_API_TOKEN nebo FREELO_EMAIL není nastaven' });
  }

  try {
    const results = [];
    let totalHodin = 0;
    let totalKc = 0;
    let activeCount = 0;
    const allKolegove = new Set();

    for (const uc of USE_CASES) {
      // Přeskoč vyloučené to-do listy
      if (EXCLUDED_LIST_IDS.includes(uc.listId)) continue;

      if (uc.multiTask) {
        // Týmové piloty na míru — jedna karta zastřešující celý to-do list
        const card = await processListAsOneCard(uc);
        results.push(card);
        if (card.status === 'inprocess') activeCount++;
      } else {
        const task = await processTask(uc.taskId);
        task.level = uc.level;
        task.direction = uc.direction;
        results.push(task);
        if (task.status === 'inprocess') activeCount++;
        if (task.usporaHodin) totalHodin += task.usporaHodin;
        if (task.usporaKc) totalKc += task.usporaKc;
        task.zapojeniKolegove.forEach(k => allKolegove.add(k));
      }
    }

    const response = {
      generatedAt: new Date().toISOString(),
      summary: {
        activeCount,
        totalHodin: Math.round(totalHodin * 10) / 10,
        totalKc,
        kolegoveCount: allKolegove.size,
      },
      useCases: results,
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error('Dashboard API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
