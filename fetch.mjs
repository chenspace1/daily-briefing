#!/usr/bin/env node
// 日报生成器 v3 —— LLM 翻译+概括 + data.json 输出
import { writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createHash } from 'crypto';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 风格 Prompt（few-shot 训练样本）──
const STYLE_PROMPT = `你是一个视频创作者的选题助手。你的任务是翻译英文新闻标题并写一句概括。

## 规则
- 标题翻译：严谨专业，技术名词保留英文（LLM、Agent、fine-tune等），不要花哨表达
- 概括：第一人称"如果你..."开头，一句话说清这条信息的实际价值或需要警惕的地方
- 不要新闻腔，不要"本文介绍了..."，像是在给做自媒体的朋友提个醒
- 如果文章纯技术硬核、没有发挥空间，直接准确翻译，不用硬凹风格
- 输出格式：每条文章占一段，段内第一行写「原文: <英文原题>」，第二行写「翻译: <中文标题>」，第三行写「概括: <一句话概括>」；不同文章段之间用空行隔开
- 全部文章处理完后，最后单独输出一行：板块总评: <一句话总结>

## 参考样本
原文: The AI Aesthetic
翻译: AI美学（科技改变界面，界面美学又将何去何从）
概括: 如果你关心AI生成内容长什么样、未来界面会怎么变，这篇给你一个框架

原文: Gemini Robotics 2 brings whole body intelligence to robots
翻译: Gemini Robotics 2 赋予机器人全身级别的智能能力
概括: 如果你还在想大模型怎么落地硬件，Google这波把视觉+语言+动作塞进了一个机器人

原文: 2x, not 10x: coding with LLMs in 2026
翻译: 2倍，不是10倍——2026年用LLM写代码的真实体验
概括: 如果你还在指望LLM让你一天写十天的代码，这篇文章会用一年的真实数据告诉你，2倍已经是天花板了

原文: Does Speaking to Agents Like Cavemen Save 65% of Tokens? We Test
翻译: 用"原始人英语"跟AI说话，Token消耗真能省65%？JetBrains团队实测
概括: 如果你日常用GPT写代码但嫌Token烧太快，这个取巧的办法实测有效，但代价是代码质量会掉

## 板块总评
处理完一个板块的全部文章后，用一句话（50字以内）总结这个板块今天值得关注的方向，格式：板块总评: xxxx`;

// ── LLM 处理（翻译 + 概括 + 总评）──
// 支持 OpenAI 兼容 API（DeepSeek / 通义千问 / 智谱 等国内 AI）
// 环境变量：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL（优先），
// 向后兼容旧名 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY;
const LLM_BASE_URL = process.env.LLM_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com';
const LLM_MODEL = process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || 'deepseek-chat';
let LLM_AVAILABLE = !!LLM_API_KEY; // 全局标记，任一块失败即设 false

async function llmProcessCategory(cat, items) {
  if (!items.length || !LLM_API_KEY) {
    if (!LLM_API_KEY) LLM_AVAILABLE = false;
    return {
      commentary: '',
      articles: items.map(i => ({
        ...i,
        zh: i.title,
        summary: '',
        id: createHash('md5').update(i.link || i.title).digest('hex').slice(0, 8),
        category: cat.key,
        breaking: false
      }))
    };
  }

  const articleList = items.map((a, i) => `${i + 1}. ${a.title}\n   URL: ${a.link}`).join('\n\n');

  try {
    // OpenAI 兼容 API（DeepSeek / 通义千问 / 智谱 等均支持此格式）
    const apiUrl = `${LLM_BASE_URL}/v1/chat/completions`;
    console.log('  LLM API:', apiUrl, 'model:', LLM_MODEL);
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 4096,
        temperature: 0.7,
        messages: [
          { role: 'system', content: STYLE_PROMPT },
          { role: 'user', content: `处理「${cat.label}」板块的 ${items.length} 篇文章。\n\n对每条输出：\n翻译: <中文标题>\n概括: <如果你...>\n\n全部处理完后，写一句板块总评。\n\n${articleList}` }
        ]
      }),
      signal: AbortSignal.timeout(120000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('API 返回异常: ' + JSON.stringify(data).slice(0, 200));

    // 解析 LLM 输出 —— 兼容 逐行格式 / JSON 数组
    const articles = [];
    let commentary = '';

    // 板块总评
    const cm = text.match(/板块总评[:：]\s*(.+)/);
    if (cm) commentary = cm[1].trim();

    // 尝试 JSON 数组（少数模型可能仍输出 JSON，兜底）
    let jsonList = null;
    try {
      const jm = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/\[\s*\{[\s\S]*\}\s*\]/s);
      if (jm) jsonList = JSON.parse(jm[1] || jm[0]);
    } catch { jsonList = null; }

    if (Array.isArray(jsonList) && jsonList.length) {
      jsonList.forEach((j, i) => {
        const item = items[i] || {};
        articles.push({
          ...item,
          zh: String(j.zh || j.translation || j.title || item.title || '').trim(),
          summary: String(j.summary || j.概括 || '').trim(),
          id: createHash('md5').update(item.link || item.title).digest('hex').slice(0, 8),
          category: cat.key,
          breaking: false
        });
      });
    } else {
      // 逐行格式：全局收集所有 翻译/概括，按出现顺序一一对应到文章
      const zhAll = [...text.matchAll(/翻译[:：]\s*([^\n]+)/g)].map(m => m[1].trim());
      const sumAll = [...text.matchAll(/概括[:：]\s*([^\n]+)/g)].map(m => m[1].trim());
      const n = Math.max(zhAll.length, sumAll.length);
      for (let i = 0; i < n; i++) {
        const item = items[i] || {};
        articles.push({
          ...item,
          zh: zhAll[i] || item.title,
          summary: sumAll[i] || '',
          id: createHash('md5').update(item.link || item.title).digest('hex').slice(0, 8),
          category: cat.key,
          breaking: false
        });
      }
    }

    // 补齐：LLM 返回不足用原文填充
    while (articles.length < items.length) {
      const item = items[articles.length];
      articles.push({
        ...item,
        zh: item.title,
        summary: '',
        id: createHash('md5').update(item.link || item.title).digest('hex').slice(0, 8),
        category: cat.key,
        breaking: false
      });
    }

    console.log(`  🤖 ${cat.label}: ${articles.length}条, 总评: ${commentary.slice(0, 30)}...`);
    return { commentary, articles };
  } catch (e) {
    console.error(`  ❌ ${cat.label} LLM 失败:`, e.message);
    LLM_AVAILABLE = false;
    return {
      commentary: '',
      articles: items.map(i => ({
        ...i,
        zh: i.title,
        summary: '',
        id: createHash('md5').update(i.link || i.title).digest('hex').slice(0, 8),
        category: cat.key,
        breaking: false
      }))
    };
  }
}

// ── Breaking 判断（关键词加权）──
const BREAKING_KWS = [
  { re: /openai|anthropic|deepseek|google\s*deepmind|meta\s*ai|microsoft\s*ai/i, weight: 2 },
  { re: /gpt-?\d|claude\s*\d|gemini\s*\d|llama\s*\d/i, weight: 3 },
  { re: /release|launch|publish|announce|reveal|unveil|introduce/i, weight: 1 },
  { re: /breakthrough|revolutionary|first.?ever|state.?of.?the.?art|record.?breaking/i, weight: 2 },
  { re: /open\s*source|开源/i, weight: 1 },
  { re: /billion|trillion|acquisition|acquired|ipo/i, weight: 1 },
  { re: /ban|blocked|sanction|regulation|illegal/i, weight: 1 },
  { re: /security|vulnerability|hack|breach|attack|exploit|critical/i, weight: 2 },
];

function checkBreaking(article) {
  const text = (article.title + ' ' + (article.zh || '')).toLowerCase();
  let score = 0;
  for (const { re, weight } of BREAKING_KWS) {
    if (re.test(text)) score += weight;
  }
  return score >= 3;
}

// ── data.json 生成 ──
function generateDataJSON(allData, summaries) {
  const breakingNews = [];
  const categories = [];

  for (const cat of CATEGORIES) {
    const items = allData[cat.key];
    const articles = items.map(a => {
      const b = checkBreaking(a);
      if (b) {
        breakingNews.push({ zh: a.zh || a.title, summary: a.summary || '', url: a.link || '' });
      }
      return {
        id: a.id || createHash('md5').update(a.link || a.title).digest('hex').slice(0, 8),
        title: a.title,
        zh: a.zh || a.title,
        summary: a.summary || '',
        source: a.source,
        url: a.link || '',
        category: cat.key,
        breaking: b,
        time: a.timeStr || '',
        author: a.author || '',
        body: a.body || '',
        bodyZh: a.bodyZh || '',
        freeLink: a.freeLink || ''
      };
    });

    categories.push({
      key: cat.key,
      icon: cat.icon,
      name: cat.label,
      commentary: summaries[cat.key]?.commentary || '',
      articleCount: articles.length,
      articles
    });
  }

  return { date: dateStr, dayOfWeek: dateStr, isWeekly: titleH1.includes('周报'), categories, breakingNews, llmAvailable: LLM_AVAILABLE };
}



// ── 存档 ──
const ARCHIVE_DIR = resolve(__dirname, 'archive');
const KEEP_DAYS = 7;
const HTML_FILES = ['index.html', 'ai.html', 'paper.html'];

function archiveCurrent() {
  const d = bjDate(Date.now());
  const folder = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  const dir = resolve(ARCHIVE_DIR, folder);
  if (existsSync(dir)) return; // 已经存过
  mkdirSync(dir, { recursive: true });
  for (const f of HTML_FILES) {
    const src = resolve(__dirname, f);
    if (existsSync(src)) copyFileSync(src, resolve(dir, f));
  }
  copyFileSync(resolve(__dirname, 'style.css'), resolve(dir, 'style.css'));
  console.log(`📦 已存档: ${folder}`);
}

function cleanOldArchives() {
  if (!existsSync(ARCHIVE_DIR)) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  cutoff.setHours(0,0,0,0);
  for (const entry of readdirSync(ARCHIVE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const d = new Date(entry.name + 'T00:00:00');
    if (isNaN(d.getTime()) || d < cutoff) {
      rmSync(resolve(ARCHIVE_DIR, entry.name), { recursive: true, force: true });
      console.log(`🗑 已清理: ${entry.name}`);
    }
  }
}

function buildArchiveIndex() {
  if (!existsSync(ARCHIVE_DIR)) { mkdirSync(ARCHIVE_DIR, { recursive: true }); }
  const dirs = readdirSync(ARCHIVE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse();

  let html = pageHeader('📅 往期日报', `最近 ${KEEP_DAYS} 天`, true, '../');
  if (!dirs.length) {
    html += '<div class="detail"><div class="card"><div class="summary">暂无往期存档</div></div></div>';
  } else {
    html += '<div class="detail">';
    for (const d of dirs) {
      const [y, m, day] = d.split('-');
      html += `<div class="card archive-card"><a href="${d}/" class="archive-link-item">📰 ${y}年${Number(m)}月${Number(day)}日</a></div>`;
    }
    html += '</div>';
  }
  html += pageFooter();
  writeFileSync(resolve(ARCHIVE_DIR, 'index.html'), html, 'utf-8');
  console.log('✅ archive/index.html');
}

// ── 配置 ──
const CATEGORIES = [
  { key:'ai',    icon:'🤖', label:'AI 动态', kw:/ai|llm|gpt|chatgpt|codex|claude|openai|anthropic|deepseek|gemini|grok|qwen|llama|kimi|glm|minimax|gemma|mistral|doubao|seed|model|transformer|diffusion|agent|chatbot|neural|rag|fine.?tun|agi/i },
  { key:'paper', icon:'📄', label:'前沿论文', kw:null },
];

// ── 日期（北京时间 UTC+8）──
const TZ_OFFSET = 8 * 3600 * 1000;
function bjDate(ms) { return new Date(ms + TZ_OFFSET); } // 其 getUTC* 方法即北京墙钟时间
const now = bjDate(Date.now());
const dow = now.getUTCDay();
let titleH1, dateStr;
if (dow === 1) {
  const lastMon = new Date(now.getTime() - 7 * 864e5); // 上周一
  const lastSun = new Date(now.getTime() - 1 * 864e5); // 上周日
  const fmt = d => `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  titleH1 = '📰 周报'; dateStr = `${fmt(lastMon)} — ${fmt(lastSun)}`;
} else {
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1, dd = now.getUTCDate();
  const wk = ['日','一','二','三','四','五','六'][now.getUTCDay()];
  titleH1 = '📰 日报';
  dateStr = `${y}年${m}月${dd}日星期${wk}`;
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
    return entries.slice(0, 8).map(e => {
      const authors = [...e.matchAll(/<name>(.*?)<\/name>/g)]
        .map(m => m[1].replace(/\s+/g, ' ').trim()).filter(Boolean);
      return {
        title: ((e.match(/<title>(.*?)<\/title>/)?.[1] || '').replace(/\s+/g, ' ').trim()),
        link: (e.match(/<id>(.*?)<\/id>/)?.[1] || ''),
        source: 'arXiv',
        authors,
        published: (e.match(/<published>(.*?)<\/published>/)?.[1] || ''),
        abstract: (e.match(/<summary>(.*?)<\/summary>/)?.[1] || '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      };
    }).filter(i => i.title);
  } catch (e) { console.error('arXiv 失败:', e.message); return []; }
}

// ── 正文抓取 ──
// 仅放行 http/https（防 SSRF / 恶意协议）
function safeUrl(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    return p.href;
  } catch { return null; }
}

// 抓取并校验为 HTML 文本；超时防卡、拒 PDF/图片/JSON 等非 HTML 类型
async function fetchHtmlText(url, timeoutMs) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
    throw new Error('not html: ' + ct);
  }
  const text = await res.text();
  if (!text.trim()) throw new Error('empty body');
  return text;
}

// 纯文本 + 分段（不截断），不含图片
function extractBody(html) {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const paras = [];
  for (const m of cleaned.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    let t = m[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (t.length >= 20) paras.push(t); // 过滤超短 / 导航杂讯
  }
  return paras.join('\n\n').trim();
}

// 正文长文阈值（字符）：超过则判定长文，丢弃正文只留链接
const BODY_MAX_CHARS = 3000;

// 主入口：原文失败 → archive.org 快照兜底；超长则丢弃正文
async function fetchArticleBody(url) {
  const safe = safeUrl(url);
  if (!safe) return { body: '', freeLink: '' };
  try {                                   // 1. 直接抓原文
    const body = extractBody(await fetchHtmlText(safe, 12000));
    if (body) {
      const tooLong = body.length > BODY_MAX_CHARS;
      return { body: tooLong ? '' : body, freeLink: '' };
    }
  } catch (e) { /* 兜底 */ }
  try {                                   // 2. archive.org 快照
    const snap = 'https://web.archive.org/web/2/' + encodeURI(safe);
    const body = extractBody(await fetchHtmlText(snap, 15000));
    if (body) {
      const tooLong = body.length > BODY_MAX_CHARS;
      return { body: tooLong ? '' : body, freeLink: snap };
    }
  } catch (e) { /* 忽略 */ }
  return { body: '', freeLink: '' };
}

// ── 正文翻译（逐篇，通俗中文）──
// 通俗化 prompt：口语、好懂、适合口播，保留段落
const BODY_ZH_PROMPT = `你是一位帮人速读外网资讯的中文编辑。请把下面这段英文文章正文逐段翻译成通俗易懂的中文，要求：
- 口语化、接地气，像读给观众听的口播稿，不要字面直译、不要翻译腔。
- 保留原文的段落结构，段落之间用空行分隔。
- 专业术语第一次出现时用括号注明英文。
- 只输出中文译文，不要解释、不要加"翻译："前缀。
直接输出译文正文：`;

async function translateBody(enText) {
  if (!enText || !LLM_API_KEY) return '';           // 无 key 不译
  try {
    const apiUrl = `${LLM_BASE_URL}/v1/chat/completions`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 6000,
        temperature: 0.5,
        messages: [
          { role: 'system', content: BODY_ZH_PROMPT },
          { role: 'user', content: enText.slice(0, 3000) }  // 防超长输入
        ]
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('  正文翻译失败:', e.message);
    return '';
  }
}

// ── 时间 / 作者格式化（北京时间）──
// 输入 epoch 毫秒，输出："8月25日 14:30 · 下午"
function beijingTimeStr(epochMs) {
  const d = bjDate(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const h = d.getUTCHours();
  const slot = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 18 ? '下午' : '晚上';
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hh}:${mm} · ${slot}`;
}

// 作者显示：前 N 个 + " 等"
function formatAuthors(authors, max = 2) {
  if (!authors || !authors.length) return '';
  const str = authors.slice(0, max).join(', ');
  return authors.length > max ? `${str} 等` : str;
}

// ── HTML 生成 ──
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function pageHeader(title, date, back, prefix='') {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(title)}</title><link rel="stylesheet" href="${prefix}style.css"><link rel="manifest" href="${prefix}manifest.json"><link rel="icon" href="${prefix}icon.svg"><meta name="theme-color" content="#f8f6f3"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default"><meta name="apple-mobile-web-app-title" content="八点日报"><link rel="apple-touch-icon" href="${prefix}icon.svg"></head><body>${back ? `<a href="${prefix}index.html" class="back">← 返回</a>` : ''}<header><h1>${esc(title)}</h1><time>${esc(date)}</time></header>`;
}

function pageFooter() {
  return `<footer>生成时间：${new Date().toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</footer><script>if('serviceWorker' in navigator){navigator.serviceWorker.register('sw.js')}</script></body></html>`;
}

function indexCard(cat, items, commentary) {
  return `<h2><span class="icon">${cat.icon}</span> ${cat.label}</h2>
  <div class="summary">${esc(commentary || `共 ${items.length} 条`)}</div>
  <div class="meta">
    <span>共 ${items.length} 条</span>
    <a href="${cat.key}.html">查看详情 →</a>
  </div>`;
}

function detailItem(item, idx, allItems) {
  const cn = item.zh || item.title;
  const sub = item.zh && item.zh !== item.title ? `${item.source} · ${item.title}` : item.source;
  // LLM 生成的概括
  const conclusion = item.summary ? `💡 ${item.summary}` : '';
  // 关联素材：同板块其他条目
  const related = allItems.filter((_, j) => j !== idx).slice(0, 3);

  return `<div class="detail-item">
  <h3><a href="${esc(item.link)}" target="_blank" rel="noopener">${idx+1}. ${esc(cn)}</a></h3>
  <div class="source-line">${esc(sub)}</div>
  ${item.timeStr ? `<div class="meta-line" style="font-size:12px;color:#8a8a8a;margin:2px 0 4px;">🕒 ${esc(item.timeStr)}${item.author ? `&nbsp; 👤 ${esc(item.author)}` : ''}</div>` : ''}
  ${conclusion ? `<div class="conclusion">${esc(conclusion)}</div>` : ''}
  ${item.freeLink ? `
  <div class="card-links" style="margin:8px 0;display:flex;gap:14px;flex-wrap:wrap;font-size:13px;">
    <a href="${esc(item.link)}" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none;">🔗 原文链接</a>
    <a href="${esc(item.freeLink)}" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none;">📦 免费快照</a>
  </div>` : ''}
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
const [hnItems, arxivPapers] = await Promise.all([
  fetchHN(), fetchArxiv(),
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
      hnData[cat.key].push({ title:item.title, link:item.url, source:'HN', time:item.time, by:item.by });
      used.add(item.id);
    }
  }
}

// 论文 = arXiv + HN
const paperSeen = new Set(arxivPapers.map(p => p.title.slice(0,40)));
const hnPapers = (hnData.paper || []).filter(p => !paperSeen.has(p.title.slice(0,40)));
const paperItems = [...arxivPapers, ...hnPapers];

// 汇总（只 AI：ai + paper）
const allData = {
  ai:    (hnData.ai || []).slice(0, 8),
  paper: paperItems.slice(0, 8),
};

// LLM 翻译 + 概括 + 总评（逐板块处理，避免超时）
console.log('🤖 LLM 处理中...');
const summaries = {};
const processedData = {};
for (const cat of CATEGORIES) {
  const items = allData[cat.key];
  const result = await llmProcessCategory(cat, items);
  processedData[cat.key] = result.articles;
  summaries[cat.key] = { commentary: result.commentary };
}
// 用 LLM 处理后的数据替换原始数据
for (const cat of CATEGORIES) {
  allData[cat.key] = processedData[cat.key];
}

// ── 富化：抓正文 + 计算时间/作者显示串 + 短文正文翻译（逐条容错）──
async function enrichArticles(allData) {
  const tasks = [];
  const toTranslate = [];
  for (const cat of CATEGORIES) {
    for (const a of allData[cat.key]) {
      if (a.source === 'arXiv') {
        a.timeStr = a.published ? beijingTimeStr(new Date(a.published).getTime()) : '';
        a.author  = formatAuthors(a.authors);
        a.body    = a.abstract || '';         // 论文正文用摘要代替
        a.freeLink = '';
        if (a.body) toTranslate.push(a);      // 摘要≤3000 视为短文，翻译
      } else {                                 // HN（含 paper 板块里的 HN 条目）
        a.timeStr = a.time ? beijingTimeStr(a.time * 1000) : '';   // HN time 是秒
        a.author  = '';                        // 作者仅 arXiv 显示
        tasks.push(fetchArticleBody(a.link).then(r => {
          a.body = r.body; a.freeLink = r.freeLink;
          if (r.body) toTranslate.push(a);    // 短文（≤3000）才翻译
        }));
      }
    }
  }
  await Promise.allSettled(tasks);             // 任一条失败仅空 body，不阻断

  // 分批并发翻译短文正文（每批 ≤4 篇，防 Actions 超时）
  if (toTranslate.length) {
    console.log(`🌐 翻译正文（${toTranslate.length} 篇短文）...`);
    const BATCH = 4;
    for (let i = 0; i < toTranslate.length; i += BATCH) {
      const batch = toTranslate.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async a => {
        a.bodyZh = await translateBody(a.body);
      }));
    }
  }
}
await enrichArticles(allData);

// ── 输出 ──

// 先把昨天的内容存档
archiveCurrent();

// 首页
let home = pageHeader(titleH1, dateStr, false);
if (!LLM_AVAILABLE) {
  home += '<div class="alert" style="text-align:center;padding:12px 16px;margin:12px 16px;background:#fff3cd;border:1px solid #ffc107;border-radius:8px;font-size:14px;color:#856404;">⚠️ 今日 AI 翻译暂不可用，标题显示为英文原文。请检查 API Key 配置。</div>';
}
home += '<div class="grid">';
for (const cat of CATEGORIES) {
  const cls = cat.key === 'learn' ? 'card wide' : 'card';
  home += `<div class="${cls}">${indexCard(cat, allData[cat.key], summaries[cat.key]?.commentary)}</div>`;
}
home += '</div><div class="archive-link"><a href="archive/">📅 往期日报</a></div>' + pageFooter();
writeFileSync(resolve(__dirname, 'index.html'), home, 'utf-8');
console.log('✅ index.html');

// 各板块详情页
for (const cat of CATEGORIES) {
  const items = allData[cat.key];

  let page = pageHeader(`${cat.icon} ${cat.label} · ${dateStr}`, dateStr, true);
  page += '<div class="detail">';
  if (!items.length) {
    page += '<div class="card"><div class="summary">暂无数据</div></div>';
  } else {
    items.forEach((item, idx) => {
      page += detailItem(item, idx, items);
    });
  }
  page += '</div>' + pageFooter();
  writeFileSync(resolve(__dirname, `${cat.key}.html`), page, 'utf-8');
  console.log(`✅ ${cat.key}.html`);
}

// 生成往期索引 + 清理过期存档
buildArchiveIndex();
cleanOldArchives();

// data.json 输出（供 Flutter App 消费）
writeFileSync(resolve(__dirname, 'data.json'), JSON.stringify(generateDataJSON(allData, summaries), null, 2), 'utf-8');
console.log('✅ data.json');

console.log('🎉 全部生成完成');
