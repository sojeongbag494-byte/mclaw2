// server.js — MCLAW backend
// 각 사용자에게 서버 위 격리된 워크스페이스(진짜 파일 시스템 + 진짜 bash) 제공
// AI 에이전트는 프론트에서 실행되지만 파일/명령은 여기 서버에서 실제로 수행

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { mkdir, readFile, writeFile, readdir, stat, rm, cp } from 'node:fs/promises';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { spawn, exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const exec = promisify(execCb);

const app = express();
app.use(express.json({ limit: '10mb' }));

// === CORS ===
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// === 환경변수 ===
const GROQ_KEYS = (process.env.GROQ_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/tmp/mclaw_workspaces';
const PORT = process.env.PORT || 3000;

if (!GROQ_KEYS.length) console.error('⚠️  GROQ_KEYS 없음');
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) console.warn('⚠️  Supabase 없음 - 익명 모드');

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// =========================================================
// 워크스페이스 관리 - 사용자별 격리된 실제 디렉토리
// =========================================================
async function ensureWorkspace(userId) {
  const dir = path.join(WORKSPACE_ROOT, userId);
  await mkdir(dir, { recursive: true });
  return dir;
}

function safePath(base, userPath) {
  const norm = path.normalize(userPath || '').replace(/^([./\\])+/, '');
  const full = path.resolve(base, norm);
  if (!full.startsWith(path.resolve(base))) {
    throw new Error('경로 감옥 위반: workspace 밖 접근 금지');
  }
  return full;
}

// =========================================================
// Bash 명령 필터 & 실행
// =========================================================
const DANGEROUS_PATTERNS = [
  /\bsudo\b/i, /\bsu\s+-/i,
  /\bchmod\s+[0-7]{3,4}\s+\//, /\bchown\b/i,
  /\brm\s+-rf?\s+\/(?!tmp\/)/i,
  /\bmkfs\b/i, /\bdd\s+if=/i,
  /\/etc\/(passwd|shadow|hosts|sudoers)/i,
  /:\s*\(\s*\)\s*\{.*\}\s*:/,     // fork bomb
  /\bnohup\b/i, /\bdisown\b/i,
  />\s*\/dev\/(?!null|stdout|stderr)/i,
  /\bnc\s.*-l/i,                   // netcat listener
  /\bcurl.*\|.*sh\b/i,             // curl | sh
  /\bwget.*\|.*sh\b/i,
];

function checkDangerous(cmd) {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(cmd)) return `보안 필터: ${p.source} 패턴 차단됨`;
  }
  return null;
}

async function runBash(userId, command, timeoutMs = 30000) {
  const workspace = await ensureWorkspace(userId);
  const danger = checkDangerous(command);
  if (danger) return { ok: false, error: danger };

  return new Promise(resolve => {
    let stdout = '', stderr = '';
    let killed = false;

    const proc = spawn('bash', ['-c', command], {
      cwd: workspace,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: workspace,
        TERM: 'dumb',
        NODE_ENV: 'production',
        LANG: 'C.UTF-8',
      },
    });

    proc.stdout.on('data', d => {
      stdout += d.toString();
      if (stdout.length > 30000) {
        stdout = stdout.slice(0, 30000) + '\n... (출력 잘림)';
        if (!killed) { killed = true; proc.kill('SIGKILL'); }
      }
    });
    proc.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 10000) stderr = stderr.slice(0, 10000);
    });
    proc.on('close', code => {
      resolve({
        ok: true,
        exit_code: code,
        stdout,
        stderr,
        message: `[exit ${code}]\n${stdout}${stderr ? '\n[stderr] ' + stderr : ''}`.slice(0, 15000),
      });
    });
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
}

// =========================================================
// 파일 조작 - 실제 서버 파일 시스템
// =========================================================
async function fsWrite(userId, filePath, content) {
  const workspace = await ensureWorkspace(userId);
  const full = safePath(workspace, filePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf-8');
  return { ok: true, message: `${filePath} 저장 (${content.length}자)` };
}

async function fsRead(userId, filePath) {
  const workspace = await ensureWorkspace(userId);
  const full = safePath(workspace, filePath);
  if (!existsSync(full)) return { ok: false, error: `${filePath} 없음` };
  const content = await readFile(full, 'utf-8');
  return { ok: true, content };
}

async function fsList(userId) {
  const workspace = await ensureWorkspace(userId);
  const files = [];
  async function walk(dir, prefix = '') {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        try {
          const s = await stat(abs);
          files.push({ path: rel, size: s.size, mtime: s.mtime.getTime() });
        } catch (e) {}
      }
    }
  }
  await walk(workspace);
  return { ok: true, files };
}

async function fsEdit(userId, filePath, oldStr, newStr) {
  const read = await fsRead(userId, filePath);
  if (!read.ok) return read;
  const cur = read.content;
  const idx = cur.indexOf(oldStr);
  if (idx === -1) {
    return {
      ok: false,
      error: `old_str "${oldStr.slice(0, 40)}${oldStr.length > 40 ? '...' : ''}" 못 찾음. read_file로 실제 내용 확인 필요.`,
    };
  }
  if (cur.indexOf(oldStr, idx + 1) !== -1) {
    return { ok: false, error: `old_str이 여러 번 나옴. 더 길고 유일한 문자열 사용.` };
  }
  await fsWrite(userId, filePath, cur.replace(oldStr, newStr));
  return { ok: true, message: `${filePath} 편집됨` };
}

async function fsDelete(userId, filePath) {
  const workspace = await ensureWorkspace(userId);
  const full = safePath(workspace, filePath);
  if (!existsSync(full)) return { ok: false, error: `${filePath} 없음` };
  await rm(full, { recursive: true, force: true });
  return { ok: true, message: `${filePath} 삭제` };
}

async function workspaceReset(userId) {
  const workspace = await ensureWorkspace(userId);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  return { ok: true, message: 'workspace 초기화됨' };
}

// =========================================================
// Groq 키 로테이션 & 대기열 (기존 로직)
// =========================================================
let keyIdx = 0;
const keyLimited = new Map();

function pickAvailableKey() {
  const now = Date.now();
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const idx = (keyIdx + i) % GROQ_KEYS.length;
    if ((keyLimited.get(idx) || 0) <= now) {
      keyIdx = (idx + 1) % GROQ_KEYS.length;
      return { idx, key: GROQ_KEYS[idx] };
    }
  }
  return null;
}
function earliestKeyReady() {
  let bestIdx = 0, bestTime = Infinity;
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const until = keyLimited.get(i) || 0;
    if (until < bestTime) { bestTime = until; bestIdx = i; }
  }
  return { idx: bestIdx, waitMs: Math.max(0, bestTime - Date.now()) };
}

let inflight = 0;
const waitQueue = [];
function acquireSlot() {
  return new Promise(resolve => {
    if (inflight < MAX_CONCURRENT) { inflight++; resolve(); }
    else waitQueue.push(resolve);
  });
}
function releaseSlot() {
  const next = waitQueue.shift();
  if (next) next();
  else inflight = Math.max(0, inflight - 1);
}

// =========================================================
// 인증 & 사용자 ID
// =========================================================
async function verifyUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!supabase) return { id: 'anon', email: 'anonymous', anonymous: true };
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch (e) { return null; }
}

function userWorkspaceId(user) {
  // Supabase user.id (UUID) 또는 익명
  return user.id || 'anon';
}

// =========================================================
// SSE 유틸
// =========================================================
function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// =========================================================
// POST /api/chat — Groq 프록시 (SSE, 대기열 + 키 로테이션)
// =========================================================
app.post('/api/chat', async (req, res) => {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: '로그인 필요' });
  if (!GROQ_KEYS.length) return res.status(503).json({ error: 'API 키 미설정' });

  sseInit(res);
  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  if (inflight >= MAX_CONCURRENT) {
    sseSend(res, 'queued', {
      position: waitQueue.length + 1,
      ahead: waitQueue.length,
      message: `대기열 진입 (앞에 ${waitQueue.length}명)`,
    });
  }
  await acquireSlot();
  if (cancelled) { releaseSlot(); return; }
  sseSend(res, 'processing', {});

  let tries = 0, shrink = 1.0;
  const MAX_TRIES = 8;
  const body = { ...req.body };

  try {
    while (tries < MAX_TRIES && !cancelled) {
      tries++;
      const keyInfo = pickAvailableKey();
      if (!keyInfo) {
        const { waitMs } = earliestKeyReady();
        if (waitMs > 300000) {
          sseSend(res, 'error', { message: '모든 키 장시간 한도' });
          break;
        }
        sseSend(res, 'waiting', { seconds: Math.ceil(waitMs / 1000), reason: 'rate_limited_all' });
        await new Promise(r => setTimeout(r, Math.max(waitMs, 3000)));
        continue;
      }
      const requestBody = { ...body };
      if (shrink < 1 && requestBody.max_tokens) {
        requestBody.max_tokens = Math.max(600, Math.floor(requestBody.max_tokens * shrink));
      }
      let groqRes;
      try {
        groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keyInfo.key}` },
          body: JSON.stringify(requestBody),
        });
      } catch (e) {
        sseSend(res, 'error', { message: `네트워크: ${e.message}` });
        break;
      }
      if (groqRes.status === 429 || groqRes.status === 413) {
        const text = await groqRes.text();
        let waitMs = 30000;
        const ra = groqRes.headers.get('retry-after');
        if (ra) waitMs = parseFloat(ra) * 1000;
        else {
          const m = text.match(/try again in ([\d.]+)\s*(ms|s)/i);
          if (m) waitMs = parseFloat(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000);
        }
        waitMs = Math.min(Math.max(waitMs + 2000, 5000), 120000);
        keyLimited.set(keyInfo.idx, Date.now() + waitMs);
        if (groqRes.status === 413) shrink *= 0.75;
        continue;
      }
      if (!groqRes.ok) {
        const text = await groqRes.text();
        console.error(`Groq ${groqRes.status}:`, text.slice(0, 500));
        if (groqRes.status === 400) {
          let parsed; try { parsed = JSON.parse(text); } catch(e) {}
          const fg = parsed && parsed.error && parsed.error.failed_generation;
          if (fg) {
            sseSend(res, 'result', { choices: [{ message: { role: 'assistant', content: fg, tool_calls: null }, finish_reason: 'stop' }], usage: {} });
            break;
          }
        }
        sseSend(res, 'error', { message: 'Groq ' + groqRes.status, status: groqRes.status, body: text.slice(0, 500) });
        break;
      }
      const data = await groqRes.json();
      sseSend(res, 'result', data);
      if (supabase && data.usage && user.id && user.id !== 'anon') {
        supabase.from('usage_logs').insert({
          user_id: user.id, model: requestBody.model || null,
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0,
          total_tokens: data.usage.total_tokens || 0,
          status_code: 200,
        }).then(({ error }) => { if (error) console.warn('usage:', error.message); });
      }
      break;
    }
    if (tries >= MAX_TRIES && !cancelled) sseSend(res, 'error', { message: `재시도 ${MAX_TRIES}회 초과` });
  } catch (e) {
    sseSend(res, 'error', { message: e.message });
  } finally {
    releaseSlot();
    if (!cancelled) res.end();
  }
});

// =========================================================
// 웹 검색 API — DuckDuckGo Instant Answer + HTML scraping
// =========================================================
app.post('/api/ws/search', toolAuthMiddleware, async (req, res) => {
  const { query, maxResults = 8 } = req.body;
  if (!query) return res.json({ ok: false, error: '검색어(query) 필요' });

  try {
    // 1차: DuckDuckGo Instant Answer API (JSON)
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const ddgRes = await fetch(ddgUrl, {
      headers: { 'User-Agent': 'MCLAW-Agent/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    const ddgData = await ddgRes.json();

    const results = [];

    // Instant Answer (AbstractText)
    if (ddgData.AbstractText) {
      results.push({
        type: 'answer',
        title: ddgData.Heading || query,
        snippet: ddgData.AbstractText.slice(0, 500),
        url: ddgData.AbstractURL || '',
        source: ddgData.AbstractSource || 'DuckDuckGo',
      });
    }

    // Related Topics
    if (ddgData.RelatedTopics && Array.isArray(ddgData.RelatedTopics)) {
      for (const t of ddgData.RelatedTopics.slice(0, 6)) {
        if (t.Text && t.FirstURL) {
          results.push({
            type: 'related',
            title: t.Text.split(' - ')[0] || t.Text.slice(0, 80),
            snippet: t.Text.slice(0, 300),
            url: t.FirstURL,
            source: 'DuckDuckGo Related',
          });
        } else if (t.Topics) {
          // 중첩 토픽
          for (const sub of t.Topics.slice(0, 3)) {
            if (sub.Text && sub.FirstURL) {
              results.push({
                type: 'related',
                title: sub.Text.slice(0, 80),
                snippet: sub.Text.slice(0, 300),
                url: sub.FirstURL,
                source: 'DuckDuckGo',
              });
            }
          }
        }
      }
    }

    // 2차: DuckDuckGo HTML 검색 결과 스크래핑 (results가 적을 때)
    if (results.length < 3) {
      try {
        const htmlRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
            'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          },
          signal: AbortSignal.timeout(10000),
        });
        const html = await htmlRes.text();
        // 결과 파싱 (정규식)
        const resultRe = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const titles = [], urls = [], snippets = [];
        let m;
        while ((m = resultRe.exec(html)) !== null && titles.length < maxResults) {
          urls.push(decodeURIComponent(m[1].replace(/.*uddg=/, '').split('&')[0]));
          titles.push(m[2].replace(/<[^>]+>/g, '').trim());
        }
        while ((m = snippetRe.exec(html)) !== null && snippets.length < maxResults) {
          snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
        }
        for (let i = 0; i < Math.min(titles.length, maxResults - results.length); i++) {
          if (titles[i] && urls[i]) {
            results.push({
              type: 'web',
              title: titles[i].slice(0, 120),
              snippet: (snippets[i] || '').slice(0, 400),
              url: urls[i],
              source: new URL(urls[i]).hostname,
            });
          }
        }
      } catch (scrapeErr) {
        console.warn('DDG HTML scrape 실패:', scrapeErr.message);
      }
    }

    if (results.length === 0) {
      return res.json({
        ok: true,
        query,
        results: [],
        message: `"${query}" 검색 결과 없음. 다른 검색어를 시도하세요.`,
      });
    }

    res.json({
      ok: true,
      query,
      totalFound: results.length,
      results: results.slice(0, maxResults),
    });
  } catch (e) {
    res.json({ ok: false, error: `검색 실패: ${e.message}` });
  }
});

// =========================================================
// 워크스페이스 도구 API — 프론트가 tool_call 받으면 여기 호출
// =========================================================
async function toolAuthMiddleware(req, res, next) {
  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ ok: false, error: '로그인 필요' });
  req.user = user;
  req.workspaceId = userWorkspaceId(user);
  next();
}

app.post('/api/ws/bash', toolAuthMiddleware, async (req, res) => {
  const { command, timeout } = req.body;
  if (!command) return res.json({ ok: false, error: '빈 명령' });
  const result = await runBash(req.workspaceId, command, Math.min(timeout || 30000, 60000));
  res.json(result);
});

app.post('/api/ws/write', toolAuthMiddleware, async (req, res) => {
  const { path: p, content } = req.body;
  if (!p) return res.json({ ok: false, error: 'path 필요' });
  try { res.json(await fsWrite(req.workspaceId, p, content || '')); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ws/read', toolAuthMiddleware, async (req, res) => {
  const { path: p } = req.body;
  if (!p) return res.json({ ok: false, error: 'path 필요' });
  try { res.json(await fsRead(req.workspaceId, p)); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ws/edit', toolAuthMiddleware, async (req, res) => {
  const { path: p, old_str, new_str } = req.body;
  if (!p) return res.json({ ok: false, error: 'path 필요' });
  try { res.json(await fsEdit(req.workspaceId, p, old_str || '', new_str || '')); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ws/delete', toolAuthMiddleware, async (req, res) => {
  const { path: p } = req.body;
  if (!p) return res.json({ ok: false, error: 'path 필요' });
  try { res.json(await fsDelete(req.workspaceId, p)); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/ws/list', toolAuthMiddleware, async (req, res) => {
  res.json(await fsList(req.workspaceId));
});

app.post('/api/ws/reset', toolAuthMiddleware, async (req, res) => {
  res.json(await workspaceReset(req.workspaceId));
});

// =========================================================
// 미리보기 - workspace의 파일을 정적 서빙
// URL: /preview/:userId/*
// (auth 토큰은 쿼리로 - iframe 호환)
// =========================================================
app.get('/preview/:userId/*', async (req, res) => {
  const token = req.query.token;
  let userId = req.params.userId;
  if (supabase && token) {
    try {
      const { data } = await supabase.auth.getUser(token);
      if (data?.user?.id === userId) {
        // OK
      } else return res.status(403).send('Forbidden');
    } catch (e) { return res.status(403).send('Forbidden'); }
  }
  const relPath = req.params[0] || 'index.html';
  try {
    const workspace = await ensureWorkspace(userId);
    const full = safePath(workspace, relPath);
    if (!existsSync(full)) return res.status(404).send('Not found');
    const ext = path.extname(full).toLowerCase();
    const types = {
      '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
      '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ico': 'image/x-icon',
      '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
    };
    res.setHeader('Content-Type', types[ext] || 'text/plain');
    createReadStream(full).pipe(res);
  } catch (e) { res.status(500).send(e.message); }
});

// =========================================================
// 워크스페이스 ZIP 다운로드
// =========================================================
app.get('/api/ws/download', toolAuthMiddleware, async (req, res) => {
  try {
    const workspace = await ensureWorkspace(req.workspaceId);
    const list = await readdir(workspace);
    if (list.length === 0) return res.status(400).json({ error: '워크스페이스 비어있음' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="mclaw-${Date.now()}.zip"`);
    const proc = spawn('zip', ['-r', '-', '.', '-x', 'node_modules/*', '.git/*'], {
      cwd: workspace,
    });
    proc.stdout.pipe(res);
    proc.stderr.on('data', d => console.error('zip stderr:', d.toString()));
    proc.on('error', e => res.status(500).send(e.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
// 대화 저장 (Supabase)
// =========================================================
app.post('/api/conversations', toolAuthMiddleware, async (req, res) => {
  if (!supabase) return res.json({ ok: false, error: 'Supabase 미설정' });
  const { id, title, messages, files } = req.body;
  const payload = {
    user_id: req.user.id,
    title: title || '새 대화',
    messages: messages || [],
    files: files || {},
  };
  if (id) {
    const { data, error } = await supabase.from('conversations')
      .update(payload).eq('id', id).eq('user_id', req.user.id).select().single();
    res.json({ ok: !error, data, error: error?.message });
  } else {
    const { data, error } = await supabase.from('conversations')
      .insert(payload).select().single();
    res.json({ ok: !error, data, error: error?.message });
  }
});

app.get('/api/conversations', toolAuthMiddleware, async (req, res) => {
  if (!supabase) return res.json({ ok: false, error: 'Supabase 미설정' });
  const { data, error } = await supabase.from('conversations')
    .select('id, title, updated_at, created_at')
    .eq('user_id', req.user.id)
    .order('updated_at', { ascending: false })
    .limit(50);
  res.json({ ok: !error, data, error: error?.message });
});

app.get('/api/conversations/:id', toolAuthMiddleware, async (req, res) => {
  if (!supabase) return res.json({ ok: false, error: 'Supabase 미설정' });
  const { data, error } = await supabase.from('conversations')
    .select('*').eq('id', req.params.id).eq('user_id', req.user.id).single();
  res.json({ ok: !error, data, error: error?.message });
});

app.delete('/api/conversations/:id', toolAuthMiddleware, async (req, res) => {
  if (!supabase) return res.json({ ok: false, error: 'Supabase 미설정' });
  const { error } = await supabase.from('conversations')
    .delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ ok: !error, error: error?.message });
});

// =========================================================
// 상태 조회
// =========================================================
app.get('/health', (req, res) => {
  const now = Date.now();
  const limitedKeys = [];
  keyLimited.forEach((until, idx) => {
    if (until > now) limitedKeys.push({ idx, secondsRemaining: Math.ceil((until - now) / 1000) });
  });
  res.json({
    ok: true, inflight, queueLength: waitQueue.length,
    totalKeys: GROQ_KEYS.length, limitedKeys,
    supabase: !!supabase, maxConcurrent: MAX_CONCURRENT,
    workspaceRoot: WORKSPACE_ROOT,
  });
});

// =========================================================
// 홈
// =========================================================
app.get('/', (req, res) => {
  res.sendFile(path.resolve('mclaw.html'));
});

app.listen(PORT, () => {
  console.log(`🐾 MCLAW backend on :${PORT}`);
  console.log(`   Groq keys: ${GROQ_KEYS.length}`);
  console.log(`   Supabase: ${supabase ? 'connected' : 'disabled'}`);
  console.log(`   Max concurrent: ${MAX_CONCURRENT}`);
  console.log(`   Workspace root: ${WORKSPACE_ROOT}`);
});
