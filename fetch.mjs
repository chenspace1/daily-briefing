#!/usr/bin/env node
// 日报生成器 v2 —— 首页概览 + 详情页（结论/背景/关联素材）
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 配置 ──
const CATEGORIES = [
  { key:'ai',      icon:'🤖', label:'AI 动态',   kw:/ai|llm|gpt|claude|openai|anthropic|deepseek|gemini|model|transformer|diffusion|agent|chatbot|neural|RAG|fine.?tun/i },
  { key:'paper',   icon:'📄', label:'前沿论文',   kw:/arxiv|paper|research|benchmark|dataset|state.of.the.art|outperform/i },
  { key:'econ',    icon:'📊', label:'经济',       kw:/economy|market|stock|fed|interest|inflation|gdp|crypto|bitcoin|tariff|trade|recession|bond|yield/i },
  { key:'leaders', icon:'🌍', label:'领导人动态', kw:null },
  { key:'learn',   icon:'📚', label:'知识学习',   kw:/tutorial|guide|book|learn|how.?to|deep.?dive|handbook|cheatsheet|best.?practice|architecture|under.?the.?hood|internals/i },
];

// ── 日期 ──
const now = new Date();
const dow = now.getDay();
let titleH1, dateStr;
if (dow === 1) {
  const lastMon = new Date(now); lastMon.setDate(now.getDate() - 7);
  const lastSun = new Date(now); lastSun.setDate(now.getDate() - 1);
  const fmt = d => d.toLocaleDateString('zh-CN', { month:'long', day:'numeric' });
  titleH1 = '📰 周报'; dateStr = `${fmt(lastMon)} — ${fmt(lastSun)}`;
} else {
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  titleH1 = '📰 日报';
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
async function translateAll(items) {
  const need = items.filter(i => /[a-zA-Z]{3,}/.test(i.title));
  for (const item of need) {
    try {
      const res = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(item.title)}&langpair=en|zh-CN&de=demo@example.com`
      );
      const data = await res.json();
      const zh = data.responseData?.translatedText?.trim();
      if (zh && zh !== item.title) item.zh = zh;
    } catch {}
  }
}

// ── 智能摘要（规则引擎）──
const TOPIC_DICT = {
  ai:     { re:[/模型|model|大模型|LLM/i, /开源|open.?source/i, /Agent|智能体/i, /安全|攻击|入侵|hack/i, /发布|推出|launch|release/i, /API|接口/i, /芯片|GPU|chip|算力/i, /巨头|ChatGPT|Claude|GPT|Gemini|KIMI|DeepSeek/i], labels:['模型能力','开源生态','Agent 智能体','安全与攻击','产品发布','API 接口','芯片算力','巨头竞争'] },
  paper:  { re:[/模型|model|LLM/i, /训练|train/i, /推理|reasoning|inference/i, /Agent|智能体|multi.?agent/i, /基准|benchmark|数据集|dataset/i, /搜索|search|RAG/i, /对齐|安全|align/i, /多模态|视觉|vision|image/i], labels:['模型架构','训练方法','推理能力','Agent 系统','基准评测','检索增强','安全对齐','多模态'] },
  econ:   { re:[/利率|interest.?rate|加息|降息/i, /通胀|inflation|CPI|物价/i, /关税|tariff|贸易战/i, /油价|oil|能源/i, /股票|股市|stock|下跌|上涨/i, /AI|科技|tech/i, /央行|Fed|ECB/i, /就业|job|失业/i], labels:['货币政策','通胀物价','贸易关税','能源市场','股市动态','科技影响','央行动向','就业市场'] },
  leaders:{ re:[/总统|president|主席/i, /总理|prime.?minister/i, /外交|访问|条约|treaty/i, /制裁|sanction/i, /选举|election|投票/i, /北约|NATO|联合国|UN/i, /冲突|战争|军事/i, /峰会|summit|G7|G20/i], labels:['首脑动态','政府更迭','外交访问','制裁博弈','选举政治','国际组织','军事冲突','多边峰会'] },
  learn:  { re:[/教程|tutorial|guide/i, /架构|architecture|design/i, /最佳实践|best.?practice/i, /手册|handbook|reference/i, /深入|deep.?dive|under.?the.?hood/i, /Rust|Python|Go|TypeScript/i, /系统|system|分布式/i, /书|book/i], labels:['实战教程','架构设计','最佳实践','参考手册','深度解析','编程语言','系统设计','好书推荐'] },
};

function generateSummary(cat, items) {
  if (!items.length) return { summary: '暂无内容。', conclusions: [] };

  const titles = items.map(i => i.zh || i.title);
  const patterns = TOPIC_DICT[cat.key]?.re || [];
  const labels = TOPIC_DICT[cat.key]?.labels || [];
  const hits = {};

  for (const t of titles) {
    for (const [idx, re] of patterns.entries()) {
      if (re.test(t)) hits[idx] = (hits[idx] || 0) + 1;
    }
  }

  const topHits = Object.entries(hits).sort((a,b) => b[1]-a[1]).slice(0, 3);

  let summary = '';
  if (topHits.length) {
    const topics = topHits.map(([idx]) => labels[idx] || `话题${idx}`).join('、');
    summary = `今日共 ${items.length} 条，集中关注：${topics}等方向。`;
  } else {
    summary = `今日共 ${items.length} 条，涉及多个方向，点击查看详情。`;
  }

  const conclusions = titles.map(t => {
    const matched = [];
    for (const [idx, re] of patterns.entries()) {
      const m = t.match(re);
      if (m) matched.push(labels[idx]);
    }
    if (matched.length) return `涉及 ${matched.slice(0, 3).join('、')}`;
    return '值得关注';
  });

  return { summary, conclusions };
}

// ── HTML 生成 ──
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function pageHeader(title, date, back) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(title)}</title><link rel="stylesheet" href="style.css"></head><body>${back ? `<a href="index.html" class="back">← 返回</a>` : ''}<header><h1>${esc(title)}</h1><time>${esc(date)}</time></header>`;
}

function pageFooter() {
  return `<footer>生成时间：${new Date().toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</footer></body></html>`;
}

function indexCard(cat, items, summary) {
  return `<h2><span class="icon">${cat.icon}</span> ${cat.label}</h2>
  <div class="summary">${esc(summary)}</div>
  <div class="meta">
    <span>共 ${items.length} 条</span>
    <a href="${cat.key}.html">查看详情 →</a>
  </div>`;
}

function detailItem(item, idx, conclusions, allItems) {
  const cn = item.zh || item.title;
  const sub = item.zh && item.zh !== item.title ? `${item.source} · ${item.title}` : item.source;
  const conclusion = conclusions[idx] || '';
  // 关联素材：同板块其他条目中标题相关的
  const related = allItems.filter((_, j) => j !== idx).slice(0, 3);

  return `<div class="detail-item">
  <h3><a href="${esc(item.link)}" target="_blank" rel="noopener">${idx+1}. ${esc(cn)}</a></h3>
  <div class="source-line">${esc(sub)}</div>
  ${conclusion ? `<div class="conclusion">${esc(conclusion)}</div>` : ''}
  <label class="toggle-btn" for="toggle-bg-${idx}">▶ 展开背景</label>
  <input type="checkbox" class="toggle" id="toggle-bg-${idx}">
  <div class="toggle-content">${esc(item.zh && item.zh !== item.title ? `原文：${item.title}` : '暂无更多背景信息。')}</div>
  ${related.length ? `
  <label class="toggle-btn" for="toggle-rel-${idx}">▶ 关联素材（${related.length}条）</label>
  <input type="checkbox" class="toggle" id="toggle-rel-${idx}">
  <div class="toggle-content"><ul class="related-list">${related.map(r => `<li><a href="${esc(r.link)}" target="_blank">${esc(r.zh || r.title)}</a></li>`).join('')}</ul></div>
  ` : ''}
</div>`;
}

// ── 主流程 ──
console.log('⏳ 拉取数据...');
const [hnItems, arxivPapers, bbcWorld, bbcBiz] = await Promise.all([
  fetchHN(), fetchArxiv(),
  fetchRSS('https://feeds.bbci.co.uk/news/world/rss.xml', 'BBC'),
  fetchRSS('https://feeds.bbci.co.uk/news/business/rss.xml', 'BBC'),
]);

// 分类 HN
const used = new Set();
const hnData = {};
for (const cat of CATEGORIES) {
  if (!cat.kw) continue;
  hnData[cat.key] = [];
  for (const item of hnItems) {
    if (used.has(item.id)) continue;
    if (cat.kw.test((item.title||'').toLowerCase())) {
      hnData[cat.key].push({ title:item.title, link:item.url, source:'HN' });
      used.add(item.id);
    }
  }
}

// 论文 = arXiv + HN
const paperSeen = new Set(arxivPapers.map(p => p.title.slice(0,40)));
const hnPapers = (hnData.paper || []).filter(p => !paperSeen.has(p.title.slice(0,40)));
const paperItems = [...arxivPapers, ...hnPapers];

// 经济 = BBC Business + HN
const econSeen = new Set();
const mergedEcon = [];
for (const e of [...bbcBiz.map(i => ({...i})), ...(hnData.econ || [])]) {
  const k = e.title.slice(0,50);
  if (!econSeen.has(k)) { econSeen.add(k); mergedEcon.push(e); }
}

// 领导人 = BBC World 过滤
const leaderKws = /president|prime.?minister|chancellor|minister|leader|Kremlin|NATO|G7|G20|summit|diplomat|sanction|treaty|tariff|Washington|Beijing|Moscow|Brussels|UN\b|United Nations|European Union|parliament|election|vote|Pentagon|Congress|Senate|embassy|foreign/i;
const leaderItems = bbcWorld.filter(i => leaderKws.test(i.title)).map(i => ({...i}));

// 汇总
const allData = {
  ai:      (hnData.ai || []).slice(0, 8),
  paper:   paperItems.slice(0, 8),
  econ:    mergedEcon.slice(0, 8),
  leaders: leaderItems.slice(0, 8),
  learn:   (hnData.learn || []).slice(0, 8),
};

// 翻译
console.log('🌐 翻译中...');
const allItems = Object.values(allData).flat();
await translateAll(allItems);

// 智能摘要
const summaries = {};
for (const cat of CATEGORIES) {
  summaries[cat.key] = generateSummary(cat, allData[cat.key]);
}

// ── 输出 ──

// 首页
let home = pageHeader(titleH1, dateStr, false);
home += '<div class="grid">';
for (const cat of CATEGORIES) {
  const cls = cat.key === 'learn' ? 'card wide' : 'card';
  home += `<div class="${cls}">${indexCard(cat, allData[cat.key], summaries[cat.key].summary)}</div>`;
}
home += '</div>' + pageFooter();
writeFileSync(resolve(__dirname, 'index.html'), home, 'utf-8');
console.log('✅ index.html');

// 各板块详情页
for (const cat of CATEGORIES) {
  const items = allData[cat.key];
  const conclusions = summaries[cat.key].conclusions;

  let page = pageHeader(`${cat.icon} ${cat.label} · ${dateStr}`, dateStr, true);
  page += '<div class="detail">';
  if (!items.length) {
    page += '<div class="card"><div class="summary">暂无数据</div></div>';
  } else {
    items.forEach((item, idx) => {
      page += detailItem(item, idx, conclusions, items);
    });
  }
  page += '</div>' + pageFooter();
  writeFileSync(resolve(__dirname, `${cat.key}.html`), page, 'utf-8');
  console.log(`✅ ${cat.key}.html`);
}

console.log('🎉 全部生成完成');
