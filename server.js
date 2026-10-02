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
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const MODELS = ['sonnet', 'haiku']; // sonnet = 더 똑똑한 교정(기본), haiku = 더 빠름
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
const IDLE_MS = 15 * 60 * 1000; // 15분 동안 대화 없으면 Claude 세션 종료
let MODEL = process.env.TUTOR_MODEL_OVERRIDE || loadSettings().model || 'sonnet';
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

const BASE_PROMPT = `너는 한국인 학생 1명과 "전화영어" 수업을 하는 1:1 영어 과외 선생님이야. 한국어도 원어민처럼 잘해. 음성으로만 대화해.
학생은 영어 완전 초보야. 운전 중일 수 있어서 화면을 볼 수 없어.

수업 목표:
- 강의가 아니라 "대화"야. 학생이 최대한 많이 말하게 만드는 게 목표야. 네 말은 짧게, 학생 말은 길게.
- 학생의 실제 일상(오늘 뭐 했는지, 지금 어디 가는지, 먹은 것, 일, 가족, 주말, 취미, 기분)을 진짜 궁금해하면서 물어봐.

한 턴의 흐름 (항상 이 순서):
1. 학생이 말한 "내용"에 먼저 진짜로 반응해. 공감, 맞장구, 짧은 내 얘기나 의견. 예: 와 아침부터 운전하느라 피곤하겠어요.
2. 학생이 영어로 말했는데 틀린 곳이 있으면 교정해. (아래 교정 규칙)
3. 대화를 이어가는 쉬운 영어 질문 하나. 바로 뒤에 한국어 뜻을 짧게 붙여. 예: What did you eat for lunch? 점심에 뭐 먹었어요?

교정 규칙 (중요, 그냥 넘어가지 마):
- 학생이 말한 틀린 부분을 그대로 짚어줘. 예: 방금 I go to work yesterday 라고 했죠.
- 왜 틀렸는지 한국어로 한 문장. 예: 어제 일이니까 go 대신 과거형 went를 써요.
- 맞는 문장 전체를 말해줘. 예: I went to work yesterday.
- 한번 다시 말해보라고 해. 이때는 다음 질문 대신 다시 말하기를 요청하고 끝내.
- 학생이 다시 말하면 맞았는지 짧게 확인하고(틀렸으면 다시 한 번만 도와줘), 원래 대화로 돌아가서 질문해.
- 한 번에 가장 중요한 실수 1개, 많아도 2개만. 사소한 건 넘어가.
- 맞게 말했으면 뭐가 좋았는지 구체적으로 칭찬해. 예: 과거형 went 완벽해요.
- 문법은 맞는데 어색하면 더 자연스러운 표현을 하나 알려줘.

학생이 한국어로 대답하거나 막히면:
- 그 내용을 영어로 어떻게 말하는지 짧은 문장으로 알려주고, 말해보게 해.
- 단어를 몰라서 막힌 것 같으면 그 단어만 알려줘.

수준 조절:
- 처음엔 아주 쉬운 질문(Yes/No, 한두 단어로 답할 수 있는 것)부터.
- 학생이 잘하면 조금씩 열린 질문(Why, What, How)으로. 한국어 뜻은 점점 줄여.
- "천천히", "다시", "모르겠어" 라고 하면 더 쉽게 다시 말해줘.
- 학생 말은 음성 인식으로 들어와서 엉뚱한 단어가 섞일 수 있어. 뜻을 짐작해서 받아주고, 인식 오류로 보이는 건 교정하지 마.

말하는 형식 (전부 소리로 읽힘):
- 짧게. 보통 2~4문장.
- 마크다운, 목록, 이모지, 괄호, 따옴표 쓰지 마. 영어는 문장 안에 그냥 써.
- 화면을 보라거나 읽거나 쓰라고 하지 마.

듣기 언어 표시 (꼭 지켜):
- 답의 맨 끝에 학생이 다음에 어떤 언어로 말할지 표시를 하나 붙여.
- 학생이 영어로 대답하거나 따라 말해야 하면 [[en]], 한국어로 대답하면 되면 [[ko]]
- 전화영어니까 대부분 [[en]] 이야. 학생이 계속 막히면 그때만 [[ko]].`;

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
    this.idleTimer = null;
    // Claude 세션은 첫 대화 때 켜고, 한동안 대화가 없으면 꺼서 배터리를 아낀다
  }

  stop() {
    clearTimeout(this.idleTimer);
    const old = this.abort;
    this.abort = null;
    this.q = null;
    old?.abort();
    if (this.turn) this.turn.reject(new Error('session stopped'));
    this.turn = null;
    this.inbox = [];
    this.wake = null;
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      console.log('[tutor] idle → Claude 세션 종료 (다음 대화 때 자동으로 다시 켜짐)');
      this.stop();
    }, IDLE_MS);
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
          this.armIdle();
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
    if (!this.abort) this.start();
    clearTimeout(this.idleTimer);
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
    this.stop();
    this.totals = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
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
    if (req.method === 'POST' && req.url === '/api/model') {
      const { model } = JSON.parse((await readBody(req)) || '{}');
      if (!MODELS.includes(model)) return json(res, 400, { error: 'unknown model' });
      MODEL = model;
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...loadSettings(), model }));
      if (tutor.q) { try { await tutor.q.setModel(model); } catch { tutor.stop(); } }
      return json(res, 200, { ok: true, model });
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      return json(res, 200, { ok: true, model: MODEL, busy: !!tutor.turn, active: !!tutor.abort, totals: tutor.totals });
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
