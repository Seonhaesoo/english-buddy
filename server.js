// 영어 회화 선생님 서버
// - Claude Agent SDK를 구독 로그인으로 사용 (API 키 불필요)
// - 세션 하나를 계속 열어두고(streaming input) 매 턴 재시작 지연을 없앤다
// - public/ 의 PWA도 같이 서빙한다 → 폰에서 http://localhost:8787 로 접속
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';
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
// 수업 기록 (레벨, 실수, 다음 주제)은 과목별 파일에 따로 쌓인다

const PROMPT_EN = `너는 한국인 학생 1명과 "전화영어" 수업을 하는 1:1 영어 과외 선생님이야. 한국어도 원어민처럼 잘해. 음성으로만 대화해.
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
- 전화영어니까 대부분 [[en]] 이야. 학생이 계속 막히면 그때만 [[ko]].

수업 형식 (한 번에 10분):
- 시작: 반갑게 인사하고, 지난 수업 기록이 있으면 지난번에 틀린 표현 하나를 다시 말해보게 하며 짧게 복습해.
- 본론: 오늘의 주제로 일상 대화. 오늘 주제와 관련된 표현을 자연스럽게 여러 번 쓰게 해.
- 끝: 앱이 수업 종료를 알려주면 마무리해. 그 전에는 먼저 끝내지 마.

학생 레벨 기준 (1~10):
1 영어 인사나 단어 몇 개만 말함
2 I'm fine 같은 아주 짧은 정해진 문장만
3 현재형 짧은 문장으로 자기 얘기를 조금
4 과거형도 쓰지만 시제·동사 실수가 많음
5 쉬운 질문에 2~3문장으로 대답
6 because 등으로 이유를 말하고 시제가 대체로 맞음
7 경험과 계획을 말할 수 있음
8 자기 의견을 자연스러운 표현으로 말함
9 긴 대화를 스스로 이어감
10 원어민과 일상 대화를 자유롭게 함
학생 레벨에 맞춰 질문 난이도와 한국어 비중을 조절해. 레벨 1~3은 한국어 설명을 넉넉히, 6 이상은 영어 위주로.

발음 피드백:
- 학생 말 끝에 (발음 참고: ...) 메모가 붙어 오면, 그건 음성 분석 결과야.
- 문법 교정이 없는 차례이거나 발음 문제가 뜻을 헷갈리게 할 정도면, 짧게 한 문장으로 발음 팁을 줘. 문법 교정이 있으면 발음은 넘어가도 돼.
- 발음 메모 자체를 읽어주거나 "음성 분석 결과" 같은 말은 하지 마.`;

const PROMPT_JA = `너는 한국인 학생 1명과 "전화 일본어" 수업을 하는 1:1 일본어 회화 과외 선생님이야. 한국어도 원어민처럼 잘해. 음성으로만 대화해.
학생은 일본어 완전 초보야(히라가나를 막 배우기 시작한 단계). 운전 중일 수 있어서 화면을 볼 수 없어.

수업 목표:
- 강의가 아니라 "대화"야. 학생이 최대한 많이 말하게 만드는 게 목표야. 네 말은 짧게, 학생 말은 길게.
- 학생의 실제 일상(오늘 뭐 했는지, 지금 어디 가는지, 먹은 것, 일, 가족, 주말, 취미, 기분)을 진짜 궁금해하면서 물어봐.
- 기본은 정중한 です・ます체로 가르쳐.

한 턴의 흐름 (항상 이 순서):
1. 학생이 말한 "내용"에 먼저 진짜로 반응해. 공감, 맞장구, 짧은 내 얘기나 의견. 예: 와 아침부터 운전하느라 피곤하겠어요.
2. 학생이 일본어로 말했는데 틀린 곳이 있으면 교정해. (아래 교정 규칙)
3. 대화를 이어가는 쉬운 일본어 질문 하나. 바로 뒤에 한국어 뜻을 짧게 붙여. 예: 昼ごはんは何を食べましたか? 점심에 뭐 먹었어요?

교정 규칙 (중요, 그냥 넘어가지 마):
- 학생이 말한 틀린 부분을 그대로 짚어줘. 예: 방금 昨日会社に行きます 라고 했죠.
- 왜 틀렸는지 한국어로 한 문장. 예: 어제 일이니까 行きます 대신 과거형 行きました를 써요.
- 맞는 문장 전체를 말해줘. 예: 昨日会社に行きました.
- 한번 다시 말해보라고 해. 이때는 다음 질문 대신 다시 말하기를 요청하고 끝내.
- 학생이 다시 말하면 맞았는지 짧게 확인하고(틀렸으면 다시 한 번만 도와줘), 원래 대화로 돌아가서 질문해.
- 한 번에 가장 중요한 실수 1개, 많아도 2개만. 조사(は/が/を/に), 동사 활용, 시제를 우선으로 봐. 사소한 건 넘어가.
- 맞게 말했으면 뭐가 좋았는지 구체적으로 칭찬해. 예: 과거형 ました 완벽해요.
- 문법은 맞는데 어색하면 더 자연스러운 표현을 하나 알려줘.

학생이 한국어로 대답하거나 막히면:
- 그 내용을 일본어로 어떻게 말하는지 짧은 문장으로 알려주고, 말해보게 해.
- 단어를 몰라서 막힌 것 같으면 그 단어만 알려줘.
- 한국어와 비슷한 단어나 문법(어순, 조사)이 있으면 그걸 활용해서 쉽게 설명해.

수준 조절:
- 처음엔 아주 쉬운 질문(はい/いいえ, 한두 단어로 답할 수 있는 것)부터.
- 학생이 잘하면 조금씩 열린 질문(なぜ, 何, どう)으로. 한국어 뜻은 점점 줄여.
- "천천히", "다시", "모르겠어" 라고 하면 더 쉽게 다시 말해줘.
- 학생 말은 음성 인식으로 들어와서 엉뚱한 단어가 섞일 수 있어. 뜻을 짐작해서 받아주고, 인식 오류로 보이는 건 교정하지 마.
- 학생 말이 히라가나로 적히든 한자로 적히든 그건 음성 인식이 정한 표기라 상관없어. 한자·가나 표기나 띄어쓰기는 절대 지적하지 마. 소리로 들리는 말만 교정해.

말하는 형식 (전부 소리로 읽힘):
- 짧게. 보통 2~4문장.
- 마크다운, 목록, 이모지, 괄호, 따옴표, 로마자 표기, 한글 발음 표기 쓰지 마. 일본어는 일본어 글자로 문장 안에 그냥 써.
- 한국어 문장과 일본어 문장은 가능하면 문장 단위로 나눠서 써. 한 문장 안에 섞을 때도 일본어 부분은 한 덩어리로.
- 화면을 보라거나 읽거나 쓰라고 하지 마.

듣기 언어 표시 (꼭 지켜):
- 답의 맨 끝에 학생이 다음에 어떤 언어로 말할지 표시를 하나 붙여.
- 학생이 일본어로 대답하거나 따라 말해야 하면 [[ja]], 한국어로 대답하면 되면 [[ko]]
- 회화 연습이니까 대부분 [[ja]] 야. 학생이 계속 막히면 그때만 [[ko]].

수업 형식 (한 번에 10분):
- 시작: 반갑게 인사하고, 지난 수업 기록이 있으면 지난번에 틀린 표현 하나를 다시 말해보게 하며 짧게 복습해.
- 본론: 오늘의 주제로 일상 대화. 오늘 주제와 관련된 표현을 자연스럽게 여러 번 쓰게 해.
- 끝: 앱이 수업 종료를 알려주면 마무리해. 그 전에는 먼저 끝내지 마.

학생 레벨 기준 (1~10):
1 일본어 인사나 단어 몇 개만 말함
2 はじめまして, よろしくお願いします 같은 정해진 짧은 문장만
3 です・ます로 자기 얘기를 조금 (N5 초반)
4 과거형 ました도 쓰지만 조사·활용 실수가 많음 (N5)
5 쉬운 질문에 2~3문장으로 대답 (N4 초반)
6 て형으로 문장을 잇고 から로 이유를 말함 (N4)
7 경험과 계획을 말할 수 있음 (N3 초반)
8 자기 의견을 자연스러운 표현으로 말함 (N3)
9 긴 대화를 스스로 이어감 (N2)
10 원어민과 일상 대화를 자유롭게 함 (N1)
학생 레벨에 맞춰 질문 난이도와 한국어 비중을 조절해. 레벨 1~3은 한국어 설명을 넉넉히, 6 이상은 일본어 위주로.

발음 피드백:
- 학생 말 끝에 (발음 참고: ...) 메모가 붙어 오면, 그건 음성 분석 결과야.
- 문법 교정이 없는 차례이거나 발음 문제가 뜻을 헷갈리게 할 정도면, 짧게 한 문장으로 발음 팁을 줘. 문법 교정이 있으면 발음은 넘어가도 돼.
- 발음 메모 자체를 읽어주거나 "음성 분석 결과" 같은 말은 하지 마.`;

const SUBJECTS = {
  en: { name: '영어', prompt: PROMPT_EN, file: 'progress.json', firstFocus: '자기소개와 오늘 하루 이야기 (첫 수업이라 레벨 파악)' },
  ja: { name: '일본어', prompt: PROMPT_JA, file: 'progress-ja.json', firstFocus: '인사와 자기소개 (첫 수업이라 레벨 파악)' },
};
function subject() { const v = loadSettings().subject; return SUBJECTS[v] ? v : 'en'; }
const progressFile = () => path.join(__dirname, SUBJECTS[subject()].file);

const EVAL_PROMPT = `[수업 종료. 이번 응답은 학생에게 들리지 않는 기록용이야.]
오늘 수업 대화 전체를 보고 학생을 평가해서 아래 JSON 하나만 출력해. 다른 글, 코드블록, [[en]] 표시는 쓰지 마.
{"level": 1~10 정수, "summary": "오늘 한 대화 한 줄 요약", "good": "잘한 점 한 줄", "improve": "가장 먼저 고칠 점 한 줄",
 "mistakes": [{"wrong": "학생이 말한 틀린 문장", "right": "맞는 문장(배우는 언어)", "meaning": "맞는 문장의 한국어 뜻"}, 최대 5개],
 "reviewed": [{"right": "이번 수업에서 복습시킨 문장 그대로", "ok": 학생이 맞게 말했으면 true, 틀렸거나 못했으면 false}],
 "next_focus": "다음 수업에서 연습할 주제와 표현 한 줄"}
reviewed 는 시스템이 알려준 "오늘 복습할 문장"을 실제로 시켜본 것만 넣어. 없으면 빈 배열.
모든 설명은 한국어로. 레벨은 위의 레벨 기준으로, 오늘 학생이 실제로 말한 외국어(배우는 언어)만 보고 정해.`;

function loadProgress() {
  let p;
  try { p = JSON.parse(fs.readFileSync(progressFile(), 'utf8')); } catch { return { lessons: [], reviews: [] }; }
  // 복습 기능 전에 쌓인 수업 기록: 그때 틀린 문장들을 복습 목록으로 옮기고 오늘부터 복습
  if (!p.reviews) {
    p.reviews = [];
    for (const l of p.lessons) {
      for (const m of (l.mistakes || []).map(asMistake).filter(Boolean)) {
        if (!p.reviews.some((x) => norm(x.right) === norm(m.right))) {
          p.reviews.push({ wrong: m.wrong, right: m.right, meaning: m.meaning || '', step: 0, due: todayStr(), added: todayStr() });
        }
      }
    }
  }
  return p;
}

function currentPlan() {
  const lessons = loadProgress().lessons;
  const last = lessons[lessons.length - 1];
  return {
    lessonNo: lessons.length + 1,
    level: last?.level ?? null,
    focus: last?.next_focus || SUBJECTS[subject()].firstFocus,
    subject: subject(),
  };
}

// 간격 반복: 맞히면 1 → 3 → 7 → 14 → 30 → 60일 뒤, 틀리면 다음 날 다시
const INTERVALS = [1, 3, 7, 14, 30, 60];
const todayStr = (addDays = 0) => {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + addDays * 86400000); // 한국 시간 기준 날짜
  return d.toISOString().slice(0, 10);
};
const norm = (t) => String(t || '').toLowerCase().replace(/[\s.,!?。、！？'"’]/g, '');

function asMistake(m) {
  if (m && typeof m === 'object') return m.right ? m : null;
  const [wrong, right] = String(m || '').split('→').map((x) => x.trim()); // 옛 형식: "틀린 → 맞는"
  return right ? { wrong, right, meaning: '' } : null;
}

function updateReviews(p, ev) {
  p.reviews = p.reviews || [];
  for (const r of ev.reviewed || []) {
    const item = p.reviews.find((x) => norm(x.right) === norm(r.right));
    if (!item) continue;
    if (r.ok) {
      item.step = Math.min((item.step || 0) + 1, INTERVALS.length - 1);
      item.reps = (item.reps || 0) + 1;
    } else {
      item.step = 0;
      item.misses = (item.misses || 0) + 1;
    }
    item.due = todayStr(INTERVALS[item.step]);
  }
  for (const m of (ev.mistakes || []).map(asMistake).filter(Boolean)) {
    const old = p.reviews.find((x) => norm(x.right) === norm(m.right));
    if (old) { old.step = 0; old.due = todayStr(1); old.misses = (old.misses || 0) + 1; continue; }
    p.reviews.push({ wrong: m.wrong, right: m.right, meaning: m.meaning || '', step: 0, due: todayStr(1), added: todayStr() });
  }
}

const dueReviews = (limit = 3) => (loadProgress().reviews || [])
  .filter((r) => r.due <= todayStr())
  .sort((a, b) => a.due.localeCompare(b.due) || (b.misses || 0) - (a.misses || 0))
  .slice(0, limit);

function loadLearnerNotes() {
  const { lessons } = loadProgress();
  const plan = currentPlan();
  let t = `\n\n이번 수업: ${plan.lessonNo}번째 수업. 오늘의 주제: ${plan.focus}`;
  const due = dueReviews();
  if (due.length) {
    t += '\n오늘 복습할 문장 (예전에 틀렸던 것. 수업 초반에 하나씩, 한국어 뜻을 말해주고 배우는 언어로 말해보게 해. 맞히면 칭찬, 틀리면 맞는 문장을 알려주고 한 번 더):';
    for (const r of due) t += `\n- 뜻: ${r.meaning || '(없음)'} / 맞는 문장: ${r.right} / 예전에 틀린 말: ${r.wrong}`;
  }
  if (!lessons.length) return t + '\n첫 수업이야. 아주 쉬운 질문부터 시작해서 학생 레벨을 파악해.';
  t += `\n학생의 현재 레벨: ${plan.level} / 10\n지난 수업 기록 (최근 순):`;
  for (const l of lessons.slice(-3).reverse()) {
    t += `\n- ${l.date} 레벨 ${l.level}: ${l.summary} / 고칠 점: ${l.improve} / 실수: ${(l.mistakes || []).map((m) => asMistake(m)).filter(Boolean).map((m) => m.wrong + ' → ' + m.right).join(', ')}`;
  }
  return t;
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
        systemPrompt: SUBJECTS[subject()].prompt + loadLearnerNotes(),
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
    this.lessonTurns = (this.lessonTurns || 0) + 1;
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

  // 수업 끝: 같은 세션에 평가를 요청 (학생에게는 안 들림) → 기록 저장 → 세션 종료
  async evaluate() {
    if (!this.abort || (this.lessonTurns || 0) < 3) return null; // 대화가 거의 없으면 평가 안 함
    const { text } = await this.say(EVAL_PROMPT, () => {});
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('평가 결과를 읽지 못했어요');
    const ev = JSON.parse(m[0]);
    ev.level = Math.min(10, Math.max(1, Math.round(Number(ev.level) || 1)));
    ev.date = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
    ev.turns = this.lessonTurns;
    const p = loadProgress();
    ev.mistakes = (ev.mistakes || []).map(asMistake).filter(Boolean);
    updateReviews(p, ev);
    p.lessons.push(ev);
    fs.writeFileSync(progressFile(), JSON.stringify(p, null, 2));
    this.stop();
    return ev;
  }

  reset() {
    this.lessonTurns = 0;
    this.stop();
    this.totals = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
}

const tutor = new Tutor();

// ---------------------------------------------------------------- AI 음성 (TTS)
// GOOGLE_TTS_API_KEY 가 있으면 Google Cloud 음성(빠름), 없고 GEMINI_API_KEY 가 있으면 Gemini 음성.
// 둘 다 없으면 앱이 폰 기본 음성을 쓴다.
const TTS_PROVIDER = process.env.GOOGLE_TTS_API_KEY ? 'google' : process.env.GEMINI_API_KEY ? 'gemini' : null;
// Google Cloud Chirp 3 HD 무료: 매달 100만 자. 넘으면 유료라 90만 자에서 멈추고 폰 기본 음성으로.
const TTS_MONTHLY_LIMIT = Number(process.env.TTS_MONTHLY_LIMIT || 900000);

function monthKey() { return new Date().toISOString().slice(0, 7); }
function ttsUsage() {
  const u = loadSettings().ttsUsage;
  return u && u.month === monthKey() ? u.chars : 0;
}
function addTtsUsage(n) {
  const st = loadSettings();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...st, ttsUsage: { month: monthKey(), chars: ttsUsage() + n } }));
}

class TtsLimitError extends Error {}

// Google Cloud: 문장 전체를 한 번에 받는다(보통 1초 이내). LINEAR16 = WAV 헤더 + 24kHz PCM
// 한글이 있는 덩어리 → 한국어, 가나·한자 덩어리 → 일본어. 숫자·기호·공백은 앞 덩어리에 붙인다.
function splitKoJa(text) {
  const parts = [];
  let cur = null;
  for (const ch of text) {
    const kind = /[\u3131-\uD79D]/.test(ch) ? 'ko-KR' : /[\u3040-\u30FF\u4E00-\u9FFF\uFF66-\uFF9F]/.test(ch) ? 'ja-JP' : null;
    if (kind && (!cur || cur.lc !== kind)) { cur = { lc: kind, text: '' }; parts.push(cur); }
    if (cur) cur.text += ch; else parts.push((cur = { lc: 'ko-KR', text: ch }));
  }
  return parts.filter((p) => p.text.trim());
}

async function synthesizeGoogle(text, voice) {
  if (subject() === 'ja') {
    const parts = splitKoJa(text);
    if (parts.length > 1 || parts[0]?.lc === 'ja-JP') {
      const pcms = await Promise.all(parts.map((p) => synthesizeGoogleOne(p.text, voice, p.lc)));
      return Buffer.concat(pcms);
    }
  }
  return synthesizeGoogleOne(text, voice, 'ko-KR');
}

async function synthesizeGoogleOne(text, voice, lc) {
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GOOGLE_TTS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: lc, name: lc + '-Chirp3-HD-' + voice },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google TTS ${r.status}: ${body.error?.message || ''}`.slice(0, 300));
  let pcm = Buffer.from(body.audioContent || '', 'base64');
  if (pcm.subarray(0, 4).toString() === 'RIFF') pcm = pcm.subarray(44); // WAV 헤더 제거
  if (!pcm.length) throw new Error('Google TTS: 오디오 없음');
  return pcm;
}
const TTS_MODEL = 'gemini-3.8-flash-tts';
const TTS_VOICES = ['Kore', 'Leda', 'Aoede', 'Callirrhoe', 'Despina', 'Puck', 'Charon', 'Fenrir', 'Orus', 'Achird'];
const TTS_STYLE = 'a warm, patient, friendly English tutor talking to a Korean beginner; clear and calm; natural Korean, and clear standard American English for English words';
const ttsCache = new Map(); // 같은 문장 다시 읽을 때 무료 사용량 아끼기

function ttsVoice() {
  const v = loadSettings().voice;
  return TTS_VOICES.includes(v) ? v : 'Kore';
}

// Gemini 스트리밍: 24kHz/16bit/mono little-endian PCM 조각을 받는 대로 onChunk 로 넘긴다
async function synthesizeStream(text, onChunk) {
  const voice = ttsVoice();
  const key = voice + '|' + text;
  if (ttsCache.has(key)) { onChunk(ttsCache.get(key)); return; }
  if (TTS_PROVIDER === 'google') {
    if (ttsUsage() + text.length > TTS_MONTHLY_LIMIT) throw new TtsLimitError('이번 달 무료 사용량을 거의 다 써서 기본 음성으로 바꿨어요');
    const pcm = await synthesizeGoogle(text, voice);
    addTtsUsage(text.length);
    ttsCache.set(key, pcm);
    if (ttsCache.size > 200) ttsCache.delete(ttsCache.keys().next().value);
    onChunk(pcm);
    return;
  }
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: [{
        type: 'user_input',
        content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: TTS_STYLE }] }],
      }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
      stream: true,
    }),
  });
  if (r.status === 429) throw new TtsLimitError('Gemini 무료 음성 하루 한도를 다 써서 기본 음성으로 바꿨어요');
  if (!r.ok) throw new Error(`Gemini TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const parts = [];
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = /^data: (\{.*)$/m.exec(block)?.[1];
      if (!data) continue;
      const ev = JSON.parse(data);
      if (ev.error) throw new Error('Gemini TTS: ' + (ev.error.message || JSON.stringify(ev.error)));
      if (ev.delta?.type === 'audio' && ev.delta.data) {
        const pcm = Buffer.from(ev.delta.data, 'base64');
        parts.push(pcm);
        onChunk(pcm);
      }
    }
  }
  if (!parts.length) throw new Error('Gemini TTS: 오디오 없음');
  ttsCache.set(key, Buffer.concat(parts));
  if (ttsCache.size > 200) ttsCache.delete(ttsCache.keys().next().value);
}

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
    const body = JSON.parse(await readBody(req));
    text = String(body.text || '').trim();
    const pron = String(body.pron || '').trim();
    if (text && pron) text += `\n(발음 참고, 학생에게는 안 보임: ${pron})`;
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

// ---------------------------------------------------------------- 음성 인식 (STT)
// 앱이 직접 녹음한 파일(webm/opus)을 받아서 글자로 바꾼다.
// 1순위 Google Cloud Speech-to-Text (한국어+영어 섞인 말도 인식), 무료 60분/월을 다 쓰면
// 2순위 Whisper (폰 안에서 직접, 무료·무제한). 둘 다 없으면 앱이 크롬 기본 인식을 쓴다.
const GOOGLE_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_TTS_API_KEY;
const STT_MONTHLY_SECONDS = Number(process.env.STT_MONTHLY_SECONDS || 55 * 60); // 무료 60분 중 55분까지만
const WHISPER_BIN = process.env.WHISPER_BIN || path.join(os.homedir(), 'whisper.cpp/build/bin/whisper-cli');
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'whisper.cpp/models/ggml-base.bin');
const hasWhisper = () => fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL);

function sttUsage() {
  const u = loadSettings().sttUsage;
  return u && u.month === monthKey() ? u.seconds : 0;
}
function addSttUsage(sec) {
  const st = loadSettings();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...st, sttUsage: { month: monthKey(), seconds: sttUsage() + sec } }));
}

function readRaw(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) reject(new Error('too large')); else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

// Gemini: "고치지 말고 들린 그대로" 받아쓰기. 초보의 문법 실수를 그대로 남겨야 선생님이 교정할 수 있다.
// (Google 음성 인식은 I eat yesterday 를 I ate 로 고쳐버리는 경우가 있음)
const STT_GEMINI_MODEL = process.env.STT_GEMINI_MODEL || 'gemini-3.5-flash-lite';
const STT_PROMPTS = {
  en: `Transcribe this audio exactly as spoken, word for word. The speaker is a Korean beginner learning English and may mix Korean and English.
Rules: keep every grammar mistake exactly as spoken (do NOT correct "I eat yesterday" to "I ate"). Write English words in English letters and Korean words in Hangul. Do not translate. Output only the transcript. If there is no clear speech, output nothing.`,
  ja: `Transcribe this audio exactly as spoken, word for word. The speaker is a Korean beginner learning Japanese and may mix Korean and Japanese.
Rules: keep every grammar, particle and conjugation mistake exactly as spoken (do NOT correct 昨日行きます to 昨日行きました). Write Japanese in natural Japanese script (kana and common kanji) and Korean in Hangul. Do not translate. Output only the transcript. If there is no clear speech, output nothing.`,
};

const PRON_PROMPT = `

Also listen to the pronunciation of the parts spoken in the language being learned (not the Korean parts).
Reply ONLY with JSON: {"transcript": "...", "pronunciation": "..."}
"pronunciation": one short Korean sentence about the single clearest mispronounced SOUND (e.g. "went 끝의 t 소리가 안 들렸어요", "つ를 '쓰'처럼 발음했어요").
Pronunciation means only how sounds were produced. NEVER mention grammar, tense, word choice or which word should be used — those are not pronunciation.
Return an empty string unless a sound was clearly wrong enough that a native speaker might misunderstand. Most turns should be empty. Empty if it was all Korean or if you are not sure.`;

async function sttGemini(audio, lang, mime) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${STT_GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: STT_PROMPTS[subject()] + (lang === 'en' ? '\nThe speaker is trying to speak English right now.' : lang === 'ja' ? '\nThe speaker is trying to speak Japanese right now.' : '') + PRON_PROMPT },
        { inline_data: { mime_type: mime, data: audio.toString('base64') } },
      ] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 429) throw Object.assign(new Error('Gemini 받아쓰기 무료 한도 초과'), { limited: true });
  if (!r.ok) throw new Error(`Gemini STT ${r.status}: ${body.error?.message || ''}`.slice(0, 300));
  const raw = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  try {
    const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    return { text: String(j.transcript || '').trim(), pron: String(j.pronunciation || '').trim() };
  } catch {
    return { text: raw, pron: '' };
  }
}

// 한도에 걸린 엔진은 한동안 건너뛴다 (매번 실패를 기다리면 느려지니까)
const sttCooldown = {};

async function sttGoogle(audio, lang) {
  const target = subject() === 'ja' ? 'ja-JP' : 'en-US';
  const primary = lang === 'en' ? 'en-US' : lang === 'ja' ? 'ja-JP' : 'ko-KR';
  // 녹음 파일 머리말(OpusHead)에서 채널 수를 읽어 그대로 알려줘야 한다 (폰마다 1 또는 2)
  const head = audio.indexOf('OpusHead');
  const channels = head >= 0 ? audio[head + 9] || 1 : 1;
  const r = await fetch('https://speech.googleapis.com/v1p1beta1/speech:recognize', {
    method: 'POST',
    headers: { 'x-goog-api-key': GOOGLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: {
        encoding: 'WEBM_OPUS',
        audioChannelCount: channels,
        languageCode: primary,
        alternativeLanguageCodes: [primary === 'ko-KR' ? target : 'ko-KR'],
        enableAutomaticPunctuation: true,
      },
      audio: { content: audio.toString('base64') },
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google STT ${r.status}: ${body.error?.message || ''}`.slice(0, 300));
  // 청구된 시간(예: "15s")을 그대로 사용량에 더한다
  const billed = parseFloat(String(body.totalBilledTime || '15s')) || 15;
  addSttUsage(billed);
  return (body.results || []).map((x) => x.alternatives?.[0]?.transcript || '').join(' ').trim();
}

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} 실패: ${String(stderr || err.message).slice(-300)}`));
      else resolve(stdout);
    });
  });
}

async function sttWhisper(audio, lang) {
  const base = path.join(os.tmpdir(), 'eb-' + Date.now());
  fs.writeFileSync(base + '.webm', audio);
  try {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', base + '.webm', '-ar', '16000', '-ac', '1', base + '.wav']);
    const threads = String(Math.min(8, Math.max(2, os.cpus().length)));
    const out = await run(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', base + '.wav', '-l', lang === 'en' || lang === 'ja' ? lang : 'auto', '-nt', '-np', '-t', threads]);
    return out.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  } finally {
    for (const ext of ['.webm', '.wav']) fs.rmSync(base + ext, { force: true });
  }
}

function sttEngines() {
  const list = [];
  if (process.env.GEMINI_API_KEY && !(sttCooldown.gemini > Date.now())) list.push('gemini');
  if (GOOGLE_KEY && sttUsage() < STT_MONTHLY_SECONDS) list.push('google');
  if (hasWhisper()) list.push('whisper');
  return list;
}

async function handleStt(req, res) {
  const lang = ['en', 'ja'].includes(req.headers['x-lang']) ? req.headers['x-lang'] : 'ko';
  const audio = await readRaw(req);
  if (audio.length < 1000) return json(res, 200, { text: '', engine: null });
  const engines = sttEngines();
  if (!engines.length) return json(res, 404, { error: 'no stt engine' });
  let lastErr;
  for (const engine of engines) {
    try {
      const t0 = Date.now();
      const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const out = engine === 'gemini' ? await sttGemini(audio, lang, mime)
        : { text: engine === 'google' ? await sttGoogle(audio, lang) : await sttWhisper(audio, lang), pron: '' };
      // 한국어로 말한 차례엔 발음 메모를 쓰지 않는다
      return json(res, 200, { text: out.text, pron: lang === 'ko' ? '' : out.pron, engine, ms: Date.now() - t0 });
    } catch (err) {
      console.error('[stt]', engine, err.message);
      if (err.limited) sttCooldown[engine] = Date.now() + 60 * 60 * 1000; // 1시간 뒤 다시 시도
      lastErr = err;
    }
  }
  return json(res, 502, { error: lastErr?.message || 'stt failed' });
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
    if (req.method === 'POST' && req.url === '/api/tts') {
      if (!TTS_PROVIDER) return json(res, 404, { error: 'no tts key' });
      const { text } = JSON.parse((await readBody(req)) || '{}');
      if (!text?.trim()) return json(res, 400, { error: 'empty' });
      let started = false;
      try {
        await synthesizeStream(text.trim(), (pcm) => {
          if (!started) {
            started = true;
            res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000', 'Cache-Control': 'no-cache' });
          }
          res.write(pcm);
        });
        return res.end();
      } catch (err) {
        console.error('[tts]', err.message);
        if (started) return res.end();
        return json(res, err instanceof TtsLimitError ? 429 : 502, { error: err.message });
      }
    }
    if (req.method === 'POST' && req.url === '/api/voice') {
      const { voice } = JSON.parse((await readBody(req)) || '{}');
      if (!TTS_VOICES.includes(voice)) return json(res, 400, { error: 'unknown voice' });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...loadSettings(), voice }));
      return json(res, 200, { ok: true, voice });
    }
    if (req.method === 'POST' && req.url === '/api/lesson/start') {
      tutor.reset();
      return json(res, 200, currentPlan());
    }
    if (req.method === 'POST' && req.url === '/api/lesson/end') {
      try {
        const ev = await tutor.evaluate();
        return json(res, 200, { ok: true, evaluation: ev, next: currentPlan() });
      } catch (err) {
        console.error('[lesson]', err.message);
        tutor.stop();
        return json(res, 500, { error: err.message });
      }
    }
    if (req.method === 'POST' && req.url === '/api/stt') return await handleStt(req, res);
    if (req.method === 'POST' && req.url === '/api/subject') {
      const { subject: sub } = JSON.parse((await readBody(req)) || '{}');
      if (!SUBJECTS[sub]) return json(res, 400, { error: 'unknown subject' });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...loadSettings(), subject: sub }));
      tutor.reset();
      return json(res, 200, currentPlan());
    }
    if (req.method === 'GET' && req.url === '/api/progress') {
      const p = loadProgress();
      return json(res, 200, {
        plan: currentPlan(), lessons: p.lessons.slice(-20).reverse(),
        reviews: { due: (p.reviews || []).filter((r) => r.due <= todayStr()).length, total: (p.reviews || []).length },
      });
    }
    if (req.method === 'GET' && req.url === '/api/review/list') {
      // 듣기 복습: 복습할 때가 된 것 → 자주 틀린 것 → 최근 것 순
      const list = (loadProgress().reviews || []).slice()
        .sort((a, b) => (a.due <= todayStr() ? 0 : 1) - (b.due <= todayStr() ? 0 : 1) || (b.misses || 0) - (a.misses || 0) || (b.added || '').localeCompare(a.added || ''))
        .slice(0, 30);
      return json(res, 200, { items: list.map((r) => ({ right: r.right, meaning: r.meaning, wrong: r.wrong })) });
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      return json(res, 200, { ok: true, model: MODEL, subject: subject(), busy: !!tutor.turn, active: !!tutor.abort, totals: tutor.totals,
        tts: TTS_PROVIDER ? {
          provider: TTS_PROVIDER, voice: ttsVoice(), voices: TTS_VOICES,
          used: TTS_PROVIDER === 'google' ? ttsUsage() : null, limit: TTS_MONTHLY_LIMIT,
        } : null,
        stt: { engines: sttEngines(), googleSeconds: GOOGLE_KEY ? Math.round(sttUsage()) : null, googleLimit: STT_MONTHLY_SECONDS, whisper: hasWhisper() } });
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
