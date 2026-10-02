// 영어 회화 선생님 서버
// - Claude Agent SDK를 구독 로그인으로 사용 (API 키 불필요)
// - 세션 하나를 계속 열어두고(streaming input) 매 턴 재시작 지연을 없앤다
// - public/ 의 PWA도 같이 서빙한다 → 폰에서 http://localhost:8787 로 접속
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MODEL = process.env.TUTOR_MODEL || 'haiku';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ENV_FILE = path.join(__dirname, '.env');

// .env 의 KEY=VALUE 읽기 (CLAUDE_CODE_OAUTH_TOKEN 등)
try {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

// Claude 데스크톱 앱/다른 세션에서 실행할 때 물려받는 인증 변수가 섞이면 로그인이 꼬인다.
// 우리 토큰(CLAUDE_CODE_OAUTH_TOKEN)만 남기고 나머지 CLAUDE_CODE_* / ANTHROPIC_* 는 제거.
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDE_CODE_OAUTH_TOKEN' || !/^(CLAUDE_CODE_|ANTHROPIC_|CLAUDECODE)/.test(k)) env[k] = v;
  }
  return env;
}
const LEARNER_FILE = path.join(__dirname, 'learner.md');

const BASE_PROMPT = `You are a warm, patient English conversation teacher talking with ONE Korean learner by VOICE.
The learner is a true beginner. They may be driving, so they cannot read anything.

How to talk:
- Speak in very short, simple sentences (A1 level). Use common everyday words only.
- Reply with 1 to 3 short sentences, then ask ONE easy question to keep the talk going.
- No markdown, no lists, no emojis, no parentheses, no special symbols. Everything you write will be read aloud.
- Talk about everyday life: food, weather, work, weekend, family, hobbies, driving, plans for today.
- If the learner makes a mistake, do not say "wrong". Gently model the correct sentence, for example: "Oh, you went to the park! Nice." Sometimes say: "You can say, I went to the park."
- If the learner speaks Korean, is stuck, or says they don't understand: FIRST say one short Korean sentence that explains what you asked or gives the English words they need (for example: "제 질문은 '무슨 일을 하세요?'라는 뜻이에요."). THEN ask an even easier English question. Keep Korean and English in separate sentences.
- If the learner asks in Korean how to say something in English, give the short English sentence, then ask them to try saying it.
- Their words come from speech recognition, so there may be recognition errors. Guess the meaning kindly. Do not comment on spelling.
- Praise small successes briefly ("Good!", "Nice sentence!").
- Slowly raise the level only when the learner answers easily several times in a row.
- Never ask the learner to read, write, or look at the screen.
- If the learner says "slower" or "천천히", use even shorter and simpler sentences.`;

function loadLearnerNotes() {
  try {
    const notes = fs.readFileSync(LEARNER_FILE, 'utf8').trim();
    return notes ? `\n\nNotes about this learner from past lessons:\n${notes}` : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- Tutor session

class Tutor {
  constructor() {
    this.inbox = [];         // 아직 SDK가 가져가지 않은 사용자 메시지
    this.wake = null;        // inbox 대기 중인 제너레이터 깨우기
    this.turn = null;        // 현재 진행 중인 턴 { onDelta, resolve, reject, text }
    this.abort = null;
    this.totals = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.start();
  }

  start() {
    this.abort = new AbortController();
    const self = this;
    async function* input() {
      while (true) {
        while (self.inbox.length === 0) {
          await new Promise((r) => (self.wake = r));
        }
        yield self.inbox.shift();
      }
    }
    this.q = query({
      prompt: input(),
      options: {
        model: MODEL,
        systemPrompt: BASE_PROMPT + loadLearnerNotes(),
        tools: [],
        settingSources: [],
        includePartialMessages: true,
        persistSession: false,
        thinking: { type: 'disabled' },
        abortController: this.abort,
        env: childEnv(),
      },
    });
    this.pump(this.q, this.abort);
  }

  async pump(q, abort) {
    try {
      for await (const msg of q) {
        const turn = this.turn;
        if (!turn) continue;
        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            turn.text += ev.delta.text;
            turn.onDelta(ev.delta.text);
          }
        } else if (msg.type === 'assistant' && msg.message?.model === '<synthetic>') {
          // 인증 실패 등은 모델 응답이 아니라 합성 메시지로 온다
          turn.error = msg.message.content?.map((c) => c.text).join(' ') || 'unknown error';
        } else if (msg.type === 'result') {
          const u = msg.usage || {};
          const stats = {
            inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
            outputTokens: u.output_tokens || 0,
            costUsd: msg.total_cost_usd || 0,
            ms: msg.duration_ms,
          };
          this.totals.turns += 1;
          this.totals.inputTokens += stats.inputTokens;
          this.totals.outputTokens += stats.outputTokens;
          this.totals.costUsd += stats.costUsd;
          this.turn = null;
          if (turn.error) turn.reject(new Error(turn.error));
          else if (msg.subtype === 'success' && !msg.is_error) turn.resolve({ text: turn.text, stats });
          else turn.reject(new Error(msg.errors?.join(', ') || msg.result || msg.subtype));
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) console.error('[tutor] session error:', err.message);
    }
    // 세션이 끝났다면(에러/중단) 대기 중인 턴을 실패 처리
    if (this.abort === abort) {
      if (this.turn) this.turn.reject(new Error('session ended'));
      this.turn = null;
      if (!abort.signal.aborted) {
        console.log('[tutor] restarting session');
        this.start();
      }
    }
  }

  say(text, onDelta) {
    if (this.turn) return Promise.reject(new Error('busy'));
    return new Promise((resolve, reject) => {
      this.turn = { onDelta, resolve, reject, text: '' };
      this.inbox.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
      this.wake?.();
      this.wake = null;
    });
  }

  reset() {
    const old = this.abort;
    this.abort = null;
    old.abort();
    if (this.turn) this.turn.reject(new Error('reset'));
    this.turn = null;
    this.inbox = [];
    this.wake = null;
    this.totals = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.start();
  }
}

const tutor = new Tutor();

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) reject(new Error('too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleChat(req, res) {
  let text;
  try {
    text = String(JSON.parse(await readBody(req)).text || '').trim();
  } catch {
    return json(res, 400, { error: 'bad request' });
  }
  if (!text) return json(res, 400, { error: 'empty' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const { stats } = await tutor.say(text, (delta) => send('delta', delta));
    send('done', { stats, totals: tutor.totals });
  } catch (err) {
    send('error', { message: err.message });
  }
  res.end();
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  if (url.pathname === '/') file = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/chat') return await handleChat(req, res);
    if (req.method === 'POST' && req.url === '/api/reset') {
      tutor.reset();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      json(res, 200, { ok: true });
      console.log('[tutor] shutdown requested');
      setTimeout(() => process.exit(0), 300);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      return json(res, 200, { ok: true, model: MODEL, busy: !!tutor.turn, totals: tutor.totals });
    }
    if (req.method === 'GET') return serveStatic(req, res);
    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  English tutor ready → http://localhost:${PORT}  (model: ${MODEL})\n`);
});
