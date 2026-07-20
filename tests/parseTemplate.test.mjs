// Jednotkové testy tolerantního parseru šablony v2 (api/dashboard.js).
// Spuštění (vyžaduje Node): `npm test`  nebo  `node --test tests/`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTemplate, hasTemplate, htmlToLines, chooseResponse } from '../api/dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(__dirname, '..', 'api', '__fixtures__', name), 'utf8');

// ---------- variace z bodu 2 zadání (syntetické) ----------

test('<strong> i <b>, dvojtečka VNĚ tučnosti', () => {
  const a = parseTemplate('<p><strong>ZADAVATEL:</strong> Jan Novák</p>');
  const b = parseTemplate('<p><b>ZADAVATEL:</b> Jan Novák</p>');
  assert.equal(a['ZADAVATEL'], 'Jan Novák');
  assert.equal(b['ZADAVATEL'], 'Jan Novák');
});

test('dvojtečka a hodnota UVNITŘ tučnosti (Freelo varianta)', () => {
  const f = parseTemplate('<div><strong>ZADAVATEL: Jakub Hovorka<br></strong><br></div>');
  assert.equal(f['ZADAVATEL'], 'Jakub Hovorka');
});

test('vnořené tagy uvnitř tučnosti (<strong><span>…</span></strong>)', () => {
  const f = parseTemplate('<p><strong><span>POPIS ŘEŠENÍ</span></strong>: AI vytěžení smluv</p>');
  assert.equal(f['POPIS RESENI'], 'AI vytěžení smluv');
});

test('mezera kolem dvojtečky (ZADAVATEL :)', () => {
  const f = parseTemplate('<p><strong>ZADAVATEL :</strong>  Jan Novák</p>');
  assert.equal(f['ZADAVATEL'], 'Jan Novák');
});

test('&nbsp; a vícenásobné mezery', () => {
  const f = parseTemplate('<p><strong>ZADAVATEL:</strong>&nbsp;&nbsp;Jan&nbsp;&nbsp;Novák</p>');
  assert.equal(f['ZADAVATEL'], 'Jan Novák');
});

test('řádkování <div> i <br> místo <p>', () => {
  const html = '<div><strong>ZADAVATEL:</strong> A</div><div><strong>POPIS ŘEŠENÍ:</strong> B</div>';
  const f = parseTemplate(html);
  assert.equal(f['ZADAVATEL'], 'A');
  assert.equal(f['POPIS RESENI'], 'B');
});

test('všechna pole v jednom <div> oddělená <br> (Freelo varianta raynet)', () => {
  const html = '<div><strong>ZADAVATEL:</strong> Kristýna<br> <strong>POPIS ŘEŠENÍ:</strong> vytěžení smluv<br> <strong>TYP PŘÍNOSU:</strong> výnos</div>';
  const f = parseTemplate(html);
  assert.equal(f['ZADAVATEL'], 'Kristýna');
  assert.equal(f['POPIS RESENI'], 'vytěžení smluv');
  assert.equal(f['TYP PRINOSU'], 'výnos');
});

test('hodnota s inline tagy (odkaz, tučnost) → textový obsah', () => {
  const f = parseTemplate('<p><strong>POPIS ŘEŠENÍ:</strong> viz <a href="http://x">odkaz</a> a <b>důraz</b></p>');
  assert.equal(f['POPIS RESENI'], 'viz odkaz a důraz');
});

test('klíč bez diakritiky a case-insensitive', () => {
  const f = parseTemplate('<p><strong>popis řešení:</strong> malými písmeny</p>');
  assert.equal(f['POPIS RESENI'], 'malými písmeny');
});

test('hodnota obsahující dvojtečku (CITÁT) — dělí se jen na první dvojtečce', () => {
  const f = parseTemplate('<p><strong>CITÁT:</strong> Alexej: "pomáhá nám to"</p>');
  assert.equal(f['CITAT'], 'Alexej: "pomáhá nám to"');
});

// ---------- pravidlo <hr> (bod 3) ----------

test('<hr>: v1 obsah pod čarou se ignoruje, když je pole nad ním', () => {
  const html = '<p><strong>ZADAVATEL:</strong> Nový</p><hr><p><strong>STATUS:</strong> hotovo</p><p><strong>VÝSLEDEK POPIS:</strong> starý v1</p>';
  const f = parseTemplate(html);
  assert.equal(f['ZADAVATEL'], 'Nový');
  assert.equal(f['VYSLEDEK POPIS'], undefined, 'v1 pole pod <hr> se nemá načíst');
});

test('<hr>: když nad čarou žádné pole není, parsuje se celý popis', () => {
  const html = '<div>NÁZEV: něco</div><hr><p><strong>ZADAVATEL:</strong> Až pod čarou</p>';
  const f = parseTemplate(html);
  assert.equal(f['ZADAVATEL'], 'Až pod čarou');
});

// ---------- reálné fixtures z Freela ----------

test('fixture onboarding (29994015) — vyplněná šablona projde filtrem', () => {
  const f = parseTemplate(fx('29994015_onboarding.html'));
  assert.equal(f['ZADAVATEL'], 'Jakub Hovorka');
  assert.ok(f['POPIS RESENI'] && f['POPIS RESENI'].startsWith('Interní onboarding'));
  assert.equal(hasTemplate(f), true);
  // v1 duplicitní VÝSLEDEK POPIS pod <hr> se nesmí protáhnout (v2 nad čarou je prázdný)
  assert.equal(f['VYSLEDEK POPIS'], '');
});

test('fixture tržní nájemné (30138724) — vyplněná šablona projde filtrem', () => {
  const f = parseTemplate(fx('30138724_trzni_najemne.html'));
  assert.equal(f['ZADAVATEL'], 'Martina Homolová');
  assert.ok(f['POPIS RESENI'] && f['POPIS RESENI'].startsWith('vytvořený a naplánovaný prompt'));
  assert.equal(hasTemplate(f), true);
});

test('fixture vytěžení smluv → Raynet (31266277) — vyplněná šablona projde filtrem', () => {
  const f = parseTemplate(fx('31266277_vyteni_smluv_raynet.html'));
  assert.ok(f['ZADAVATEL'] && f['ZADAVATEL'].startsWith('Kristýna'));
  assert.ok(f['POPIS RESENI'] && f['POPIS RESENI'].includes('Raynet'));
  assert.equal(f['TYP PRINOSU'], 'výnos');
  assert.equal(hasTemplate(f), true);
});

test('fixture v1-only leftover (29834225) — NEprojde filtrem (chybí POPIS ŘEŠENÍ i ZADAVATEL)', () => {
  const f = parseTemplate(fx('29834225_skeleton_dotaznikotesty.html'));
  assert.equal(hasTemplate(f), false, 'v1 zbytek bez v2 polí se nesmí zobrazit');
});

test('fixture strojový prázdný skeleton v2 — NEprojde filtrem', () => {
  const f = parseTemplate(fx('skeleton_empty_v2.html'));
  assert.equal(hasTemplate(f), false, 'prázdný skeleton se nesmí zobrazit');
});

// ---------- chooseResponse: nikdy necachovat degradovaný výsledek ----------

const PAYLOAD = { generatedAt: '2026-07-20T10:00:00.000Z', dlazdice: { hotovo: 4 }, sekce: {}, hlavicka: {}, log: [] };
const GOOD = { generatedAt: '2026-07-20T09:00:00.000Z', dlazdice: { hotovo: 4 }, sekce: {}, hlavicka: {}, log: ['x'] };

test('chooseResponse: kompletní běh → cachovat + uložit jako dobrou verzi', () => {
  const r = chooseResponse({ payload: PAYLOAD, incomplete: false, incompleteInfo: '', lastGood: null });
  assert.equal(r.status, 200);
  assert.equal(r.storeGood, true);
  assert.match(r.cacheControl, /s-maxage=900/);
  assert.equal(r.body, PAYLOAD);
});

test('chooseResponse: nekompletní + existuje dobrá verze → servíruj ji, no-store', () => {
  const r = chooseResponse({ payload: PAYLOAD, incomplete: true, incompleteInfo: '3 popisů nenačteno (kód 429)', lastGood: GOOD });
  assert.equal(r.status, 200);
  assert.equal(r.storeGood, false);
  assert.equal(r.cacheControl, 'no-store');
  assert.equal(r.body.dlazdice.hotovo, 4);
  assert.equal(r.body.servedStale, true);
  assert.ok(r.body.log.some(l => l.includes('poslední dobrou verzi')), 'log má poznámku o stale verzi');
  assert.ok(r.body.log.some(l => l.includes('429')), 'log obsahuje kód chyby');
});

test('chooseResponse: nekompletní + žádná dobrá verze (studený start) → částečná data, no-store', () => {
  const r = chooseResponse({ payload: PAYLOAD, incomplete: true, incompleteInfo: '2 popisů nenačteno (kód NET)', lastGood: null });
  assert.equal(r.cacheControl, 'no-store');
  assert.equal(r.body.incomplete, true);
  assert.equal(r.storeGood, false);
  assert.ok(r.body.log.some(l => l.includes('částečná data')));
});

// ---------- pomocná htmlToLines ----------

test('htmlToLines: <br>, </div>, <hr> jsou konce řádků', () => {
  const lines = htmlToLines('a<br>b</div>c<hr>d');
  assert.deepEqual(lines.map(s => s.trim()).filter(Boolean), ['a', 'b', 'c', 'd']);
});
