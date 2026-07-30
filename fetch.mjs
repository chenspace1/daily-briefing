#!/usr/bin/env node
// 日报生成器 —— 每天早上 8 点运行，生成前一天的静态简报
// 用法: node fetch.mjs

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 日期 ──
const now = new Date();
const dow = now.getDay();
let title, dateStr;
if (dow === 1) {
  const lastMon = new Date(now); lastMon.setDate(now.getDate() - 7);
  const lastSun = new Date(now); lastSun.setDate(now.getDate() - 1);
  const fmt = d => d.toLocaleDateString('zh-CN', { month:'long', day:'numeric' });
  title = '📰 周报'; dateStr = `${fmt(lastMon)} — ${fmt(lastSun)}`;
} else {
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  title = '📰 日报';
  dateStr = yesterday.toLocaleDateString('zh-CN', { year:'numeric', month:'long', day:'numeric', weekday:'long' });
}

// ── 数据获取 ──
async function fetchHN() {
  const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
  const ids = await res.json();
  const items = await Promise.all(
    ids.slice(0, 50).map(id =>
      fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json()).catch(() => null)
    )
  );
  return items.filter(i => i && i.title && i.url);
}

function classifyHN(items) {
  const ai = /ai|llm|gpt|claude|openai|anthropic|deepseek|gemini|model|transformer|diffusion|agent|chatbot|neural|RAG|fine.?tun/i;
  const paper = /arxiv|paper|research|benchmark|dataset|state.of.the.art|outperform/i;
  const econ = /economy|market|stock|fed|interest|inflation|gdp|crypto|bitcoin|tariff|trade|recession|bond|yield/i;
  const learn = /tutorial|guide|book|learn|how.?to|deep.?dive|handbook|cheatsheet|best.?practice|architecture|under.?the.?hood|internals/i;
  const bins = { ai:[], paper:[], econ:[], learn:[] };
  const used = new Set();
  for (const item of items) {
    if (used.has(item.id)) continue;
    const t = (item.title||'').toLowerCase();
    for (const [k, re] of Object.entries({ ai, paper, econ, learn })) {
      if (re.test(t)) { bins[k].push(item); used.add(item.id); break; }
    }
  }
  return bins;
}

async function fetchArxiv() {
  try {
    const url = 'https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL&sortBy=submittedDate&max_results=10';
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const xml = await res.text();
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    return entries.slice(0, 8).map(e => ({
      title: ((e.match(/<title>(.*?)<\/title>/)?.[1] || '').replace(/\s+/g, ' ').trim()),
      link: (e.match(/<id>(.*?)<\/id>/)?.[1] || ''), source: 'arXiv'
    })).filter(i => i.title);
  } catch (e) { console.error('arXiv 失败:', e.message); return []; }
}

async function fetchRSS(url, label) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const xml = await res.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return items.map(e => ({
      title: (e.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || e.match(/<title>(.*?)<\/title>/)?.[1] || '').trim(),
      link: (e.match(/<link>(.*?)<\/link>/)?.[1] || '').trim(), source: label
    })).filter(i => i.title && i.link);
  } catch (e) { console.error(`${label} RSS 失败:`, e.message); return []; }
}

// ── 翻译 ──
const SEP = '\n<<<SEP>>>\n';
async function translateAll(itemGroups) {
  const all = itemGroups.flat();
  const toTranslate = all.filter(i => i.title && /[a-zA-Z]{3,}/.test(i.title));
  if (!toTranslate.length) return;

  // 逐条翻译，避免拼接问题
  for (const item of toTranslate) {
    try {
      const res = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(item.title)}&langpair=en|zh-CN&de=demo@example.com`
      );
      const data = await res.json();
      const zh = data.responseData?.translatedText?.trim();
      if (zh && zh !== item.title) item.zh = zh;
    } catch { /* 失败留原文 */ }
  }
}

// ── HTML 渲染 ──
function cardHtml(icon, label, items) {
  if (!items.length) return `<div class="card"><h2><span class="icon">${icon}</span> ${label}</h2><ol><li class="empty">暂无数据</li></ol></div>`;
  const list = items.slice(0, 8).map((item, idx) => {
    const main = item.zh || item.title;
    const sub = item.zh && item.zh !== item.title ? `${item.source} · ${item.title}` : item.source;
    return `<li><a href="${item.link}" target="_blank" rel="noopener">${main}</a><span class="source">${sub}</span></li>`;
  }).join('');
  return `<div class="card"><h2><span class="icon">${icon}</span> ${label}</h2><ol>${list}</ol></div>`;
}

// ── 主流程 ──
console.log('⏳ 拉取数据...');
const [hnItems, arxivPapers, bbcWorld, bbcBiz] = await Promise.all([
  fetchHN(), fetchArxiv(),
  fetchRSS('https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC'),
  fetchRSS('https://feeds.bbci.co.uk/news/business/rss.xml', 'BBC'),
]);
const classified = classifyHN(hnItems);

// 组装
const aiItems      = classified.ai.map(i => ({ title:i.title, link:i.url, source:'HN' }));
const hnPapers     = classified.paper.map(p => ({ title:p.title, link:p.url, source:'HN' }));
const paperSeen    = new Set(arxivPapers.map(p => p.title.slice(0,40)));
const paperItems   = [...arxivPapers, ...hnPapers.filter(p => !paperSeen.has(p.title.slice(0,40)))];

const econSeen = new Set();
const hnEcon = classified.econ.map(i => ({ title:i.title, link:i.url, source:'HN' }));
const mergedEcon = [];
for (const e of [...bbcBiz, ...hnEcon]) {
  const k = e.title.slice(0, 50);
  if (!econSeen.has(k)) { econSeen.add(k); mergedEcon.push(e); }
}

const leaderKws = /president|prime.?minister|chancellor|minister|leader|白宫|克里姆林|Kremlin|NATO|G7|G20|summit|diplomat|sanction|treaty|tariff|Washington|Beijing|Moscow|Brussels|UN\b|United Nations|European Union|EU\b|state.?visit|foreign|白厅|Downing|Pentagon|Congress|Senate|parliament|election|vote|cabinet|embassy/i;
const leaderItems = bbcWorld.filter(i => leaderKws.test(i.title));
const learnItems = classified.learn.map(i => ({ title:i.title, link:i.url, source:'HN' }));

console.log('🌐 翻译中...');
await translateAll([aiItems, paperItems, mergedEcon, leaderItems, learnItems]);

// 生成 HTML
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    background:#f8f6f3;color:#2c2c2c;line-height:1.6;padding:2rem 1.5rem;max-width:1100px;margin:0 auto
  }
  header{text-align:center;margin-bottom:2.5rem}
  header h1{font-size:1.6rem;font-weight:600;letter-spacing:.02em}
  header time{font-size:.85rem;color:#888;margin-top:.25rem;display:block}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem}
  .card{background:#fff;border-radius:12px;padding:1.35rem 1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.04);border:1px solid #f0ede8}
  .card.wide{grid-column:1/-1}
  .card h2{font-size:1rem;font-weight:600;margin-bottom:.9rem;padding-bottom:.6rem;border-bottom:1px solid #f0ede8;display:flex;align-items:center;gap:.4rem}
  .card h2 .icon{font-size:1.1rem}
  .card ol{list-style:none;counter-reset:item}
  .card li{counter-increment:item;font-size:.9rem;padding:.35rem 0;border-bottom:1px solid #faf8f5}
  .card li:last-child{border-bottom:none}
  .card li a{color:#2c2c2c;text-decoration:none;display:block;transition:color .15s}
  .card li a:hover{color:#2563eb}
  .card li a::before{content:counter(item)".";color:#bbb;font-size:.75rem;margin-right:.5rem;font-variant-numeric:tabular-nums}
  .card .source{font-size:.72rem;color:#aaa;margin-left:1.2rem}
  .empty{color:#bbb;font-size:.85rem;font-style:italic}
  .card li.empty a{display:inline}
  .card li.empty a::before{content:none}
  footer{text-align:center;margin-top:2rem;font-size:.75rem;color:#bbb}
  @media(max-width:700px){.grid{grid-template-columns:1fr}body{padding:1rem .75rem}}
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <time>${dateStr}</time>
</header>
<div class="grid">
  ${cardHtml('🤖','AI 动态', aiItems)}
  ${cardHtml('📄','前沿论文', paperItems)}
  ${cardHtml('📊','经济', mergedEcon)}
  ${cardHtml('🌍','领导人动态', leaderItems)}
  <div class="card wide">
    <h2><span class="icon">📚</span> 知识学习</h2>
    <ol>${learnItems.length ? learnItems.slice(0,8).map((item,idx) =>
      `<li><a href="${item.link}" target="_blank" rel="noopener">${item.zh || item.title}</a><span class="source">${item.zh && item.zh !== item.title ? item.source + ' · ' + item.title : item.source}</span></li>`
    ).join('') : '<li class="empty">暂无数据</li>'}</ol>
  </div>
</div>
<footer>生成时间：${new Date().toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</footer>
</body>
</html>`;

writeFileSync(resolve(__dirname, 'index.html'), html);
console.log('✅ 日报已生成');
