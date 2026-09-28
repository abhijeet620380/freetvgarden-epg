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

function normalizeName(name) {
  return String(name).toLowerCase().replace(/\b(hd|fhd|uhd|4k|1080p|720p|sd|hq|tv|live)\b/g, '').replace(/[^a-z0-9]/g, '');
}

// "ZeeCinema.in" -> "in", "Foo.us2" -> "us". Empty string when the id has no country suffix.
const CC_ALIAS = { uk: 'gb' };
const normCC = (c) => CC_ALIAS[c] || c;
function xmlIdCountry(xmlId) {
  const m = String(xmlId).toLowerCase().match(/\.([a-z]{2,3})\d*$/);
  return m ? normCC(m[1]) : '';
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

  const validById = new Map(), validByName = new Map();
  statusData.forEach(c => {
    if (c.id && c.country && c.status === 'live') {
      const ourData = { originalId: c.id, country: c.country.toLowerCase() };
      validById.set(c.id.toLowerCase(), ourData);
      validByName.set(normalizeName(c.name), ourData);
    }
  });

  // Decide how much we trust an XMLTV channel for one of our channels.
  //   3 = the XMLTV id IS our channel id (best)
  //   2 = same normalized name AND the XMLTV id ends in the same country code
  //   1 = same normalized name, XMLTV id has no country suffix (unknown origin)
  //   rejected = same name but the id says a DIFFERENT country (e.g. "Zee Cinema" US/UK feed
  //              being attached to the Indian channel) -> never used
  function resolveChannel(xmlId, displayName) {
    const byId = validById.get(xmlId.toLowerCase());
    if (byId) return { data: byId, prio: 3 };
    const byName = validByName.get(normalizeName(displayName));
    if (!byName) return null;
    const cc = xmlIdCountry(xmlId);
    if (cc && cc === normCC(byName.country)) return { data: byName, prio: 2 };
    if (!cc) return { data: byName, prio: 1 };
    return { rejected: byName };
  }

  const files = await readdir('.');
  const guideFiles = files.filter(f => f.startsWith('guide-') && f.endsWith('.xml.gz'));
  if (guideFiles.length === 0) return console.log('No guide files found.');

  const now = Date.now(), windowEnd = now + WINDOW_HOURS * 60 * 60 * 1000;
  // ourId -> Map(sourceKey -> { prio, country, xmlId, progs[] })
  const bySource = new Map();
  // ourId -> Set of XMLTV ids that matched by name but belong to another country
  const rejected = new Map();

  for (const file of guideFiles) {
    console.log(`Processing ${file}...`);
    const rl = readline.createInterface({ input: createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    const xmlIdToOurData = new Map();
    let currentXmlId = null, currentProg = null;

    for await (const line of rl) {
      if (line.includes('<channel id=')) {
        const match = line.match(/id="([^"]+)"/);
        if (match) currentXmlId = match[1];
        continue;
      }
      if (currentXmlId && line.includes('<display-name')) {
        const nameMatch = line.match(/>([^<]+)<\/display-name>/);
        if (nameMatch) {
          const r = resolveChannel(currentXmlId, decodeXml(nameMatch[1]));
          if (r && r.data) {
            const prev = xmlIdToOurData.get(currentXmlId);
            if (!prev || prev.prio < r.prio) xmlIdToOurData.set(currentXmlId, { ...r.data, prio: r.prio });
          } else if (r && r.rejected) {
            const id = r.rejected.originalId;
            if (!rejected.has(id)) rejected.set(id, new Set());
            rejected.get(id).add(currentXmlId);
          }
        }
        currentXmlId = null; continue;
      }
      if (line.includes('<programme ')) {
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
          if (!bySource.has(src.originalId)) bySource.set(src.originalId, new Map());
          const sources = bySource.get(src.originalId);
          const key = `${file}|${xmlId}`;
          if (!sources.has(key)) sources.set(key, { prio: src.prio, country: src.country, xmlId, file, progs: [] });
          sources.get(key).progs.push({ title: currentProg.title, start: currentProg.start, stop: currentProg.stop });
        }
        currentProg = null;
      }
    }
  }

  // For every channel keep exactly ONE source (best trust level, then most airtime covered),
  // instead of merging every schedule that shares the same name.
  const countryEpg = {};
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

    const rej = rejected.get(ourId);
    const multi = sources.size > 1 || (rej && rej.size > 0);
    if (DEBUG_IDS.has(ourId.toLowerCase()) || (multi && logged < 40)) {
      if (!DEBUG_IDS.has(ourId.toLowerCase())) logged++;
      console.log(`SOURCES ${ourId}: used ${best.xmlId} | candidates: ${summary.join(', ')}` +
        (rej && rej.size ? ` | rejected other-country ids: ${[...rej].slice(0, 6).join(', ')}` : ''));
    }
  }

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
  console.log('EPG build complete.');
}

main().catch(console.error);
