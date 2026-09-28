import { readdir, mkdir, writeFile } from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import zlib from 'zlib';
import path from 'path';

// Fetches your live channel list directly from your main data repository
const STATUS_URL = 'https://raw.githubusercontent.com/abhijeet620380/freetvgarden-data-v2/main/iptv/status.json';
const OUT_DIR = './epg';

// How far ahead of the build time programmes are kept.
// 36h means the guide still has data even if the daily run is late or skipped.
const WINDOW_HOURS = 36;

// Channels that always get a diagnostic line in the Actions log (add more if you want).
const DEBUG_IDS = new Set(['zeecinema.in', 'b4umusic.in', 'aajtak.in']);

function parseXmltvDate(str) {
  if (!str) return 0;
  const y = str.slice(0, 4), m = str.slice(4, 6), d = str.slice(6, 8);
  const h = str.slice(8, 10), min = str.slice(10, 12), sec = str.slice(12, 14);
  let tz = '+00:00';
  if (str.length > 15) tz = `${str.slice(15, 16)}${str.slice(16, 18)}:${str.slice(18, 20)}`;
  return new Date(`${y}-${m}-${d}T${h}:${min}:${sec}${tz}`).getTime();
}

// Turn a channel name into a comparison key.
// IMPROVED: the old version kept only a-z0-9, so every non-Latin name ("आज तक", "قناة ...")
// collapsed to an EMPTY key and accented Latin letters were deleted ("Télé" -> "tl").
// Now: accents are folded (é -> e), letters/digits of ANY script are kept, "+" and "&"
// are spelled out so "Canal+" != "Canal", and quality/noise words are dropped.
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')      // fold Latin accents
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ')            // drop "(HD)", "[Geo-blocked]" ...
    .replace(/\b(hd|fhd|uhd|4k|1080p|720p|sd|hq|tv|live)\b/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');                   // keep letters/marks/digits of any script
}

// "ZeeCinema.in" -> "in", "Foo.us2" -> "us". Empty string when the id has no country suffix.
const CC_ALIAS = { uk: 'gb' };
const normCC = (c) => CC_ALIAS[c] || c;
function xmlIdCountry(xmlId) {
  const m = String(xmlId).toLowerCase().match(/\.([a-z]{2,3})\d*$/);
  return m ? normCC(m[1]) : '';
}

// IMPROVED id key: lowercase, drop an "@feed" suffix ("AajTak.in@SD" -> "aajtak.in"),
// and drop the numeric variant some XMLTV files add after the country ("Foo.us2" -> "foo.us").
// Both OUR ids and XMLTV ids go through this, so "the XMLTV id IS our id" matches more often.
function idKey(id) {
  return String(id || '').toLowerCase().replace(/@.*$/, '').replace(/(\.[a-z]{2,3})\d+$/, '$1');
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Remove exact duplicates and resolve overlaps so a channel never has two "now" programmes.
// When two programmes overlap, the later-starting one wins and the earlier one is cut short.
function cleanList(list) {
  const sorted = list.slice().sort((a, b) => a.start - b.start || a.stop - b.stop);
  const out = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && last.start === p.start && last.title === p.title) continue; // exact duplicate
    if (last && p.start < last.stop) {
      last.stop = p.start;
      if (last.stop <= last.start) out.pop();
    }
    out.push({ title: p.title, start: p.start, stop: p.stop });
  }
  return out;
}

async function main() {
  console.log('Fetching channel list from main repository...');
  const res = await fetch(STATUS_URL);
  if (!res.ok) return console.log('Failed to fetch status.json. Ensure the main repository is public.');
  const statusData = await res.json();

  // ---- Index OUR live channels -------------------------------------------------------
  // validById   : idKey  -> ourData                (one channel per id)
  // validByName : name   -> [ourData, ourData...]  (IMPROVED: a LIST - the old Map kept only
  //               the last channel with a given name, silently dropping the others, e.g.
  //               "BBC News" in two countries, or duplicate entries of the same channel)
  const validById = new Map(), validByName = new Map();
  const liveList = [];                                   // for the coverage report at the end
  const addName = (nm, data) => {
    const k = normalizeName(nm);
    if (!k) return;
    if (!validByName.has(k)) validByName.set(k, []);
    const arr = validByName.get(k);
    if (!arr.includes(data)) arr.push(data);
  };
  statusData.forEach(c => {
    if (c.id && c.country && c.status === 'live') {
      const ourData = { originalId: c.id, country: c.country.toLowerCase(), name: c.name || c.id };
      const k = idKey(c.id);
      if (!validById.has(k)) validById.set(k, ourData);
      addName(c.name, ourData);
      if (c.native_name) addName(c.native_name, ourData); // NEW: also match on the native-script name
      liveList.push(ourData);
    }
  });

  // Decide how much we trust an XMLTV channel for our channels. Looks at the XMLTV id AND
  // EVERY display-name of that channel (IMPROVED: the old code only ever read the first one).
  //   prio 3 = the XMLTV id IS our channel id (best)
  //   prio 2 = same normalized name AND the XMLTV id ends in the same country code
  //   prio 1 = same normalized name, XMLTV id has no country suffix, and all our channels
  //            with that name are in ONE country (otherwise it is ambiguous -> skipped)
  //   rejected = the name matches but the id says a DIFFERENT country (e.g. a "Zee Cinema"
  //            US/UK feed being attached to the Indian channel) -> never used
  // Returns { targets: [ourData...], prio } or { rejected: [ourData...] } or null.
  function resolveChannel(xmlId, displayNames) {
    const byId = validById.get(idKey(xmlId));
    if (byId) return { targets: [byId], prio: 3 };

    const cc = xmlIdCountry(xmlId);
    let best = null, rejected = null;
    for (const dn of displayNames) {
      const cands = validByName.get(normalizeName(dn));
      if (!cands || !cands.length) continue;
      if (cc) {
        const same = cands.filter(c => normCC(c.country) === cc);
        if (same.length) { if (!best || best.prio < 2) best = { targets: same, prio: 2 }; }
        else rejected = cands;
      } else {
        const countries = new Set(cands.map(c => normCC(c.country)));
        if (countries.size === 1) { if (!best) best = { targets: cands, prio: 1 }; }
        else rejected = cands;                            // same name in several countries: can't tell which
      }
    }
    if (best) return best;
    return rejected ? { rejected } : null;
  }

  const files = await readdir('.');
  const guideFiles = files.filter(f => f.startsWith('guide-') && f.endsWith('.xml.gz'));
  if (guideFiles.length === 0) return console.log('No guide files found.');

  const now = Date.now(), windowEnd = now + WINDOW_HOURS * 60 * 60 * 1000;
  // ourId -> Map(sourceKey -> { prio, country, xmlId, progs[] })
  const bySource = new Map();
  // ourId -> Set of XMLTV ids that matched by name but belong to another country / are ambiguous
  const rejected = new Map();
  let xmlChannelCount = 0, xmlChannelMatched = 0;

  for (const file of guideFiles) {
    console.log(`Processing ${file}...`);
    const rl = readline.createInterface({ input: createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    const xmlIdToOurData = new Map();                    // xmlId -> { targets[], prio }
    let currentXmlId = null, currentNames = [], currentProg = null;

    // Called when a <channel> block ends: resolve it against our channels.
    const finishChannel = () => {
      if (!currentXmlId) return;
      xmlChannelCount++;
      const r = resolveChannel(currentXmlId, currentNames);
      if (r && r.targets) {
        const prev = xmlIdToOurData.get(currentXmlId);
        if (!prev || prev.prio < r.prio) { xmlIdToOurData.set(currentXmlId, r); xmlChannelMatched++; }
      } else if (r && r.rejected) {
        for (const t of r.rejected) {
          if (!rejected.has(t.originalId)) rejected.set(t.originalId, new Set());
          rejected.get(t.originalId).add(currentXmlId);
        }
      }
      currentXmlId = null; currentNames = [];
    };

    for await (const line of rl) {
      if (line.includes('<channel id=')) {
        finishChannel();                                 // safety: previous block without </channel>
        const match = line.match(/id="([^"]+)"/);
        currentXmlId = match ? match[1] : null;
        currentNames = [];
      }
      if (currentXmlId && line.includes('<display-name')) {
        // IMPROVED: collect EVERY display-name (also handles several on one line).
        for (const m of line.matchAll(/<display-name[^>]*>([^<]+)<\/display-name>/g)) currentNames.push(decodeXml(m[1]));
      }
      if (currentXmlId && line.includes('</channel>')) { finishChannel(); continue; }
      if (line.includes('<channel id=')) continue;

      if (line.includes('<programme ')) {
        finishChannel();                                 // in case a channel block was never closed
        currentProg = null;
        const start = line.match(/start="([^"]+)"/), stop = line.match(/stop="([^"]+)"/), ch = line.match(/channel="([^"]+)"/);
        if (start && stop && ch && xmlIdToOurData.has(ch[1])) {
          const startTime = parseXmltvDate(start[1]), stopTime = parseXmltvDate(stop[1]);
          if (stopTime > now && startTime < windowEnd) {
            currentProg = { xmlId: ch[1], src: xmlIdToOurData.get(ch[1]), start: startTime, stop: stopTime, title: '' };
          }
        }
        continue;
      }
      if (currentProg && line.includes('<title')) {
        const titleMatch = line.match(/>([^<]+)<\/title>/);
        if (titleMatch) currentProg.title = decodeXml(titleMatch[1]).trim();
        continue;
      }
      if (currentProg && line.includes('</programme>')) {
        const { src, xmlId } = currentProg;
        if (currentProg.title) {
          // One XMLTV channel can feed several of our channels (same name, same country).
          for (const t of src.targets) {
            if (!bySource.has(t.originalId)) bySource.set(t.originalId, new Map());
            const sources = bySource.get(t.originalId);
            const key = `${file}|${xmlId}`;
            if (!sources.has(key)) sources.set(key, { prio: src.prio, country: t.country, xmlId, file, progs: [] });
            sources.get(key).progs.push({ title: currentProg.title, start: currentProg.start, stop: currentProg.stop });
          }
        }
        currentProg = null;
      }
    }
    finishChannel();
  }
  console.log(`XMLTV channels read: ${xmlChannelCount}, matched to one of our live channels: ${xmlChannelMatched}.`);

  // For every channel keep exactly ONE source (best trust level, then most airtime covered),
  // instead of merging every schedule that shares the same name.
  const countryEpg = {};
  const tierCount = { 3: 0, 2: 0, 1: 0 };
  let logged = 0;
  for (const [ourId, sources] of bySource) {
    let best = null;
    const summary = [];
    for (const s of sources.values()) {
      const list = cleanList(s.progs);
      const covered = list.reduce((sum, p) => sum + Math.max(0, Math.min(p.stop, windowEnd) - Math.max(p.start, now)), 0);
      summary.push(`${s.xmlId}[prio${s.prio}, ${list.length} progs, ${(covered / 3600000).toFixed(1)}h]`);
      if (!best || s.prio > best.prio || (s.prio === best.prio && covered > best.covered)) {
        best = { prio: s.prio, covered, list, country: s.country, xmlId: s.xmlId };
      }
    }
    if (!best || !best.list.length) continue;
    if (!countryEpg[best.country]) countryEpg[best.country] = {};
    countryEpg[best.country][ourId] = best.list;
    tierCount[best.prio]++;

    const rej = rejected.get(ourId);
    const multi = sources.size > 1 || (rej && rej.size > 0);
    if (DEBUG_IDS.has(ourId.toLowerCase()) || (multi && logged < 40)) {
      if (!DEBUG_IDS.has(ourId.toLowerCase())) logged++;
      console.log(`SOURCES ${ourId}: used ${best.xmlId} | candidates: ${summary.join(', ')}` +
        (rej && rej.size ? ` | rejected other-country ids: ${[...rej].slice(0, 6).join(', ')}` : ''));
    }
  }

  // ---- Coverage report: which of our live channels still have NO guide -----------------
  const withEpg = new Set();
  for (const chans of Object.values(countryEpg)) for (const id of Object.keys(chans)) withEpg.add(id);
  const missingByCountry = {};
  for (const c of liveList) {
    if (withEpg.has(c.originalId)) continue;
    (missingByCountry[c.country] ||= []).push({ id: c.originalId, name: c.name });
  }
  const totalLive = liveList.length, totalWith = withEpg.size;
  console.log(`EPG coverage: ${totalWith}/${totalLive} live channels (${((totalWith / Math.max(1, totalLive)) * 100).toFixed(1)}%). ` +
    `Matched by id: ${tierCount[3]}, by name+country: ${tierCount[2]}, by name only: ${tierCount[1]}.`);
  const worst = Object.entries(missingByCountry).sort((a, b) => b[1].length - a[1].length).slice(0, 15);
  console.log('Countries with most channels still WITHOUT a guide: ' + worst.map(([cc, l]) => `${cc}:${l.length}`).join(', '));

  await mkdir(OUT_DIR, { recursive: true });
  // Time the SOURCE file was last updated (workflow passes its Last-Modified header);
  // falls back to the build time when it isn't available.
  const srcModified = Date.parse(process.env.SOURCE_MODIFIED || '');
  const generated = Number.isFinite(srcModified) ? srcModified : Date.now();
  console.log(`Guide "updated" time: ${new Date(generated).toISOString()} (${Number.isFinite(srcModified) ? 'source Last-Modified' : 'build time'})`);
  for (const [cc, channels] of Object.entries(countryEpg)) {
    channels.__generated = generated; // read by epg-addon.js to show "updated ... ago"
    await writeFile(path.join(OUT_DIR, `${cc}.json`), JSON.stringify(channels));
  }
  // List of live channels that still have no guide, grouped by country (for you to review;
  // the website never reads this file). "_" prefix keeps it from clashing with a country code.
  await writeFile(path.join(OUT_DIR, '_unmatched.json'),
    JSON.stringify({ generated, totalLive, withEpg: totalWith, missing: missingByCountry }));
  console.log('EPG build complete.');
}

main().catch(console.error);
