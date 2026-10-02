// English Buddy — 듣기 → 서버(Claude) → 문장 단위로 읽어주기 → 다시 듣기
'use strict';

const $ = (id) => document.getElementById(id);
const orb = $('orb'), orbLabel = $('orbLabel'), live = $('live'), log = $('log');
const statsEl = $('stats'), conn = $('conn');

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;

const S = {
  mode: 'idle',          // idle | listening | thinking | speaking | paused | error
  started: false,
  handsFree: true,       // 말이 끝나면 자동으로 다시 듣기
  rate: Number(localStorage.getItem('rate') || 0.85),
  lastReply: '',
  rec: null,
  silentTries: 0,
  speakQueue: [],
  streamDone: true,
  wakeLock: null,
};

// ------------------------------------------------------------------ UI

const LABELS = {
  idle: '탭해서<br>말하기',
  listening: '듣는 중…',
  thinking: '생각 중…',
  speaking: '말하는 중<br><small>탭하면 끊기</small>',
  paused: '일시정지<br><small>탭해서 계속</small>',
  error: '오류<br><small>탭해서 재시도</small>',
};

function setMode(mode, liveText) {
  S.mode = mode;
  orb.className = 'orb ' + mode;
  orbLabel.innerHTML = S.started || mode !== 'idle' ? LABELS[mode] : '탭해서<br>시작';
  if (liveText !== undefined) live.textContent = liveText;
}

function addMsg(who, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function showStats(totals) {
  if (!totals) return;
  const cost = totals.costUsd ? ` · API 환산 $${totals.costUsd.toFixed(4)} (구독이라 실제 청구 없음)` : '';
  statsEl.textContent = `대화 ${totals.turns}턴 · 토큰 ${totals.inputTokens.toLocaleString()} / ${totals.outputTokens.toLocaleString()}${cost}`;
}

$('rate').value = S.rate;
$('rateOut').textContent = S.rate.toFixed(2);
$('rate').addEventListener('input', (e) => {
  S.rate = Number(e.target.value);
  $('rateOut').textContent = S.rate.toFixed(2);
  try { localStorage.setItem('rate', S.rate); } catch {}
});

// ------------------------------------------------------------------ 화면 꺼짐 방지

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !S.wakeLock) {
      S.wakeLock = await navigator.wakeLock.request('screen');
      S.wakeLock.addEventListener('release', () => (S.wakeLock = null));
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.started) keepAwake();
});

// ------------------------------------------------------------------ 음성 출력 (TTS)

let voices = [];
const voiceSel = { en: $('voiceEn'), ko: $('voiceKo') };
const langOf = (v) => v.lang.replace('_', '-');

function fillVoiceSelect(kind) {
  const sel = voiceSel[kind];
  const saved = (() => { try { return localStorage.getItem('voice-' + kind); } catch { return null; } })();
  // 영어는 미국/영국/호주 등 모든 영어 목소리, 미국 먼저
  const list = voices
    .filter((v) => langOf(v).startsWith(kind))
    .sort((a, b) => (langOf(b) === 'en-US') - (langOf(a) === 'en-US') || a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">자동</option>' +
    list.map((v) => `<option value="${v.name}">${v.name} (${langOf(v)})</option>`).join('');
  if (saved && list.some((v) => v.name === saved)) sel.value = saved;
}

function loadVoices() {
  voices = synth ? synth.getVoices() : [];
  fillVoiceSelect('en');
  fillVoiceSelect('ko');
}
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

for (const kind of ['en', 'ko']) {
  voiceSel[kind].addEventListener('change', (e) => {
    try { localStorage.setItem('voice-' + kind, e.target.value); } catch {}
  });
}

function pickVoice(lang) {
  const chosen = voiceSel[lang.slice(0, 2)]?.value;
  if (chosen) {
    const v = voices.find((x) => x.name === chosen);
    if (v) return v;
  }
  const same = voices.filter((v) => langOf(v).startsWith(lang));
  return same.find((v) => /google/i.test(v.name)) || same[0] || null;
}

const HANGUL = /[ㄱ-힝]/;
const keep = []; // 일부 크롬에서 utterance가 GC되면 onend가 안 불리는 문제 방지

function speakChunk(text, rateMul = 1) {
  return new Promise((resolve) => {
    const lang = HANGUL.test(text) ? 'ko-KR' : 'en-US';
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.voice = pickVoice(lang);
    u.rate = S.rate * rateMul * (lang === 'ko-KR' ? 1.1 : 1);
    u.onend = u.onerror = () => { keep.splice(keep.indexOf(u), 1); resolve(); };
    keep.push(u);
    synth.speak(u);
  });
}

let speaking = false;
async function pumpSpeech() {
  if (speaking) return;
  speaking = true;
  while (S.speakQueue.length) {
    if (S.mode !== 'speaking') setMode('speaking');
    await speakChunk(S.speakQueue.shift());
    if (S.mode !== 'speaking') { speaking = false; return; } // 사용자가 끊음
  }
  speaking = false;
  if (S.streamDone && S.mode === 'speaking') afterSpeech();
}

function enqueueSpeech(text) {
  text = text.trim();
  if (!text) return;
  S.speakQueue.push(text);
  pumpSpeech();
}

function stopSpeech() {
  S.speakQueue = [];
  synth && synth.cancel();
}

function afterSpeech() {
  setMode('idle', '');
  if (S.handsFree) setTimeout(() => S.mode === 'idle' && listen(), 250);
}

// ------------------------------------------------------------------ 음성 인식 (STT)

function listen(lang = 'en-US') {
  if (!SR) {
    setMode('error', '이 브라우저는 음성 인식을 지원하지 않아요. 안드로이드 크롬을 써주세요.');
    return;
  }
  stopSpeech();
  const rec = new SR();
  S.rec = rec;
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;

  let finalText = '';
  let errType = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    live.textContent = (finalText + ' ' + interim).trim();
  };
  rec.onerror = (e) => { errType = e.error; };
  rec.onend = () => {
    if (S.rec !== rec) return;
    S.rec = null;
    const text = finalText.trim();
    if (text) {
      S.silentTries = 0;
      ask(text);
      return;
    }
    if (errType === 'not-allowed' || errType === 'service-not-allowed') {
      setMode('error', '마이크 권한이 필요해요. 주소창 왼쪽 자물쇠 → 권한 → 마이크 허용');
      return;
    }
    if (S.mode !== 'listening') return; // 사용자가 직접 멈춤
    // 아무 말도 없었음 → 몇 번은 조용히 다시 듣고, 너무 오래면 쉬기
    S.silentTries += 1;
    if (S.handsFree && S.silentTries < 6) {
      setTimeout(() => S.mode === 'listening' && listen(lang), 200);
    } else {
      S.silentTries = 0;
      setMode('paused', '조용해서 잠깐 쉬어요. 화면을 탭하면 다시 들어요.');
    }
  };

  setMode('listening', lang === 'ko-KR' ? '한국어로 말해보세요…' : 'Speak English…');
  try { rec.start(); } catch { /* 이미 시작됨 */ }
}

function stopListening() {
  if (S.rec) { const r = S.rec; r.stop(); }
}

// ------------------------------------------------------------------ 서버 대화

async function ask(text, { hidden = false } = {}) {
  if (!hidden) addMsg('me', text);
  setMode('thinking', '');
  stopSpeech();
  S.streamDone = false;

  const bubble = addMsg('tutor', '');
  let full = '';
  let pending = ''; // 아직 문장이 안 끝난 부분

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) throw new Error('서버 응답 ' + res.status);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] || 'null');
        if (ev === 'delta') {
          full += data;
          pending += data;
          bubble.textContent = full;
          log.scrollTop = log.scrollHeight;
          // 문장이 끝날 때마다 바로 읽기 시작 → 답이 다 오기 전에 말하기 시작
          let m;
          while ((m = /^([\s\S]*?[.!?])\s+/.exec(pending))) {
            enqueueSpeech(m[1]);
            pending = pending.slice(m[0].length);
          }
        } else if (ev === 'done') {
          showStats(data.totals);
        } else if (ev === 'error') {
          throw new Error(data.message);
        }
      }
    }
    enqueueSpeech(pending);
    S.lastReply = full.trim();
    S.streamDone = true;
    if (!full.trim()) afterSpeech();
    else if (!speaking && !S.speakQueue.length) afterSpeech();
  } catch (err) {
    S.streamDone = true;
    bubble.remove();
    const msg = /authenticate|login|token/i.test(err.message)
      ? '로그인 토큰 문제예요. 서버의 .env 토큰을 확인하세요. (' + err.message + ')'
      : '오류: ' + err.message;
    addMsg('sys', msg);
    setMode('error', '');
  }
}

// ------------------------------------------------------------------ 버튼

orb.addEventListener('click', () => {
  if (!S.started) {
    S.started = true;
    S.handsFree = true;
    keepAwake();
    if (synth) synth.speak(new SpeechSynthesisUtterance('')); // 모바일 TTS 잠금 해제
    ask('[The learner just opened the app. Greet them in English very simply and ask one easy question.]', { hidden: true });
    return;
  }
  switch (S.mode) {
    case 'speaking': stopSpeech(); listen(); break;          // 말 끊고 바로 내 차례
    case 'listening': S.mode = 'idle'; stopListening(); setMode('idle', ''); break;
    case 'thinking': break;
    default: S.silentTries = 0; listen();
  }
});

$('btnSlow').addEventListener('click', async () => {
  if (!S.lastReply || S.mode === 'thinking') return;
  if (S.rec) { S.mode = 'idle'; stopListening(); }
  stopSpeech();
  setMode('speaking', '천천히 다시…');
  const parts = S.lastReply.match(/[^.!?]+[.!?]*/g) || [S.lastReply];
  for (const p of parts) {
    await speakChunk(p.trim(), 0.75);
    if (S.mode !== 'speaking') return;
  }
  afterSpeech();
});

$('btnPreview').addEventListener('click', async () => {
  if (S.mode === 'thinking' || S.mode === 'speaking' || S.mode === 'listening') return;
  stopSpeech();
  await speakChunk("Hi! Nice to meet you. How was your day?");
  await speakChunk('안녕하세요! 천천히 같이 연습해요.');
});

$('btnKo').addEventListener('click', () => {
  if (S.mode === 'thinking') return;
  if (S.rec) { S.mode = 'idle'; stopListening(); }
  stopSpeech();
  S.started = true;
  setTimeout(() => listen('ko-KR'), 150);
});

$('btnPause').addEventListener('click', () => {
  S.handsFree = !S.handsFree;
  $('btnPause').classList.toggle('on', !S.handsFree);
  $('btnPause').querySelector('span').textContent = S.handsFree ? '일시정지' : '자동듣기 꺼짐';
  if (!S.handsFree) {
    if (S.rec) { S.mode = 'idle'; stopListening(); }
    stopSpeech();
    setMode('paused', '');
  } else if (S.mode === 'paused' || S.mode === 'idle') {
    listen();
  }
});

$('btnReset').addEventListener('click', async () => {
  if (!confirm('새 대화를 시작할까요? 지금 대화 내용은 사라져요.')) return;
  if (S.rec) { S.mode = 'idle'; stopListening(); }
  stopSpeech();
  log.innerHTML = '';
  statsEl.textContent = '';
  S.started = false;
  S.lastReply = '';
  await fetch('/api/reset', { method: 'POST' }).catch(() => {});
  setMode('idle', '');
});

$('btnOff').addEventListener('click', async () => {
  if (!confirm('서버를 끌까요? 다음엔 홈 화면의 English Buddy 아이콘으로 다시 켜면 돼요.')) return;
  if (S.rec) { S.mode = 'idle'; stopListening(); }
  stopSpeech();
  await fetch('/api/shutdown', { method: 'POST' }).catch(() => {});
  setMode('paused', '서버를 껐어요. 이 창은 닫아도 돼요.');
  checkServer();
});

// ------------------------------------------------------------------ 시작

async function checkServer() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    conn.textContent = '서버 연결됨 · ' + s.model;
    conn.className = 'conn ok';
    showStats(s.totals);
  } catch {
    conn.textContent = '서버 꺼짐 — 홈 화면의 English Buddy 아이콘으로 켜주세요';
    conn.className = 'conn bad';
  }
}
checkServer();
setInterval(checkServer, 15000);
setMode('idle', SR ? '' : '이 브라우저는 음성 인식을 지원하지 않아요. 크롬을 써주세요.');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
