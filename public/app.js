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
  listenLang: 'ko-KR',
  btDelay: Number(localStorage.getItem('btDelay') ?? 800), // 블루투스 깨우는 시간(ms)
  needWake: false,  // 학생이 말할 언어 (선생님 답의 [[en]]/[[ko]] 로 자동 전환)
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

// 한 문장 안의 한국어/영어 부분을 나눈다 → 각각 맞는 목소리로 읽기
// 예: "오늘 날씨 좋다는 영어로 It's a nice day 라고 해요." → [ko, en, ko]
function splitByLang(text) {
  const parts = [];
  let cur = null;
  for (const ch of text) {
    const kind = HANGUL.test(ch) ? 'ko' : /[A-Za-z]/.test(ch) ? 'en' : null;
    if (kind && (!cur || cur.kind !== kind)) {
      cur = { kind, text: '' };
      parts.push(cur);
    }
    if (cur) cur.text += ch;
    else parts.push((cur = { kind: 'ko', text: ch }));
  }
  return parts.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => /[A-Za-z0-9ㄱ-힝]/.test(p.text));
}

async function speakChunk(text, rateMul = 1) {
  for (const part of splitByLang(text)) {
    await speakOne(part.text, part.kind === 'ko' ? 'ko-KR' : 'en-US', rateMul);
  }
}

function speakOne(text, lang, rateMul) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.voice = pickVoice(lang);
    u.rate = S.rate * rateMul * (lang === 'ko-KR' ? 1.1 : 1);
    u.onend = u.onerror = () => { keep.splice(keep.indexOf(u), 1); resolve(); };
    keep.push(u);
    synth.speak(u);
  });
}

// 차량 블루투스는 소리가 시작될 때 연결/볼륨을 서서히 올린다 → 첫마디가 작게 들림.
// 말하기 직전에 거의 안 들리는 소리를 잠깐 틀어서 블루투스를 먼저 깨운다.
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}
function wakeAudio() {
  const ms = S.btDelay;
  if (!ms || !audioCtx) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.002; // 사실상 안 들리는 크기 (완전 무음이면 블루투스가 안 깨어남)
      osc.frequency.value = 220;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      setTimeout(() => { osc.stop(); resolve(); }, ms);
    } catch { resolve(); }
  });
}

// ---- Gemini AI 음성: 서버(/api/tts)에서 wav 를 받아 재생. 실패하면 폰 기본 음성으로.
function fetchTTS(text) {
  if (!S.tts) return Promise.resolve(null);
  return fetch('/api/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  }).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
}

function playBlob(blob, rateMul) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    // 속도 슬라이더 0.85 = AI 음성의 원래 속도
    a.playbackRate = Math.min(1.5, Math.max(0.5, (S.rate / 0.85) * rateMul));
    const done = () => { URL.revokeObjectURL(url); if (S.audioEl === a) { S.audioEl = null; S.audioDone = null; } resolve(); };
    S.audioEl = a;
    S.audioDone = done;
    a.onended = a.onerror = done;
    a.play().catch(done);
  });
}

async function speakText(text, rateMul = 1, audioPromise) {
  const blob = await (audioPromise || fetchTTS(text));
  if (blob) return playBlob(blob, rateMul);
  return speakChunk(text, rateMul);
}

let speaking = false;
async function pumpSpeech() {
  if (speaking) return;
  speaking = true;
  while (S.speakQueue.length) {
    if (S.mode !== 'speaking') setMode('speaking');
    if (S.needWake) { S.needWake = false; await wakeAudio(); }
    const item = S.speakQueue.shift();
    await speakText(item.text, 1, item.audio);
    if (S.mode !== 'speaking') { speaking = false; return; } // 사용자가 끊음
  }
  speaking = false;
  if (S.streamDone && S.mode === 'speaking') afterSpeech();
}

function enqueueSpeech(text) {
  text = text.trim();
  if (!text) return;
  // AI 음성이면 재생 순서가 오기 전에 미리 받아둔다
  S.speakQueue.push({ text, audio: S.tts ? fetchTTS(text) : null });
  pumpSpeech();
}

function stopSpeech() {
  S.speakQueue = [];
  synth && synth.cancel();
  if (S.audioEl) { S.audioEl.pause(); S.audioDone?.(); }
}

function afterSpeech() {
  setMode('idle', '');
  if (S.handsFree) setTimeout(() => S.mode === 'idle' && listen(), 250);
}

// 선생님 답 끝의 [[en]] / [[ko]] = 학생이 다음에 말할 언어
const LANG_TAG = /\[\[(en|ko)\]\]/g;
const stripTags = (t) => t.replace(LANG_TAG, '').replace(/\[\[?[a-z]{0,2}\]?$/, '');

function setListenLang(lang) {
  S.listenLang = lang;
  const b = $('btnKo');
  b.firstChild.textContent = lang === 'en-US' ? '🇺🇸' : '🇰🇷';
  b.querySelector('span').textContent = lang === 'en-US' ? '영어로 듣는 중' : '한국어로 듣는 중';
}

// ------------------------------------------------------------------ 음성 인식 (STT)

function listen(lang = S.listenLang) {
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

  setMode('listening', lang === 'ko-KR' ? '듣는 중 (한국어)…' : '영어로 말해보세요…');
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
  S.needWake = true;

  const bubble = addMsg('tutor', '');
  let full = '';
  let pending = ''; // 아직 문장이 안 끝난 부분
  let rest = '';    // AI 음성일 때 첫 문장 뒤를 모아두는 곳
  let firstSent = false;

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
          bubble.textContent = stripTags(full);
          log.scrollTop = log.scrollHeight;
          // 문장이 끝날 때마다 바로 읽기 시작 → 답이 다 오기 전에 말하기 시작
          let m;
          while ((m = /^([\s\S]*?[.!?])\s+/.exec(pending))) {
            // AI 음성: 첫 문장만 바로 읽고, 나머지는 모아서 한 번에 (무료 사용량 절약)
            if (!S.tts || !firstSent) enqueueSpeech(stripTags(m[1]));
            else rest += m[1] + ' ';
            firstSent = true;
            pending = pending.slice(m[0].length);
          }
        } else if (ev === 'done') {
          showStats(data.totals);
        } else if (ev === 'error') {
          throw new Error(data.message);
        }
      }
    }
    const tags = [...full.matchAll(LANG_TAG)];
    setListenLang(tags.length && tags[tags.length - 1][1] === 'en' ? 'en-US' : 'ko-KR');
    enqueueSpeech(stripTags(rest + pending));
    full = stripTags(full);
    bubble.textContent = full;
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
  if (S.serverUp === false) return startServerViaTermux();
  if (!S.started) {
    S.started = true;
    S.handsFree = true;
    keepAwake();
    unlockAudio();
    if (synth) synth.speak(new SpeechSynthesisUtterance('')); // 모바일 TTS 잠금 해제
    ask('[학생이 방금 앱을 켰어. 전화영어 수업 시작이야. 한국어로 짧게 반갑게 인사하고, 아주 쉬운 영어 질문 하나로 대화를 시작해.]', { hidden: true });
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
  await wakeAudio();
  if (S.tts) {
    await speakText(S.lastReply, 0.75);
    if (S.mode !== 'speaking') return;
  } else {
    const parts = S.lastReply.match(/[^.!?]+[.!?]*/g) || [S.lastReply];
    for (const p of parts) {
      await speakChunk(p.trim(), 0.75);
      if (S.mode !== 'speaking') return;
    }
  }
  afterSpeech();
});

$('btnPreview').addEventListener('click', async () => {
  if (S.mode === 'thinking' || S.mode === 'speaking' || S.mode === 'listening') return;
  stopSpeech();
  unlockAudio();
  await wakeAudio();
  await speakText('안녕하세요! 오늘 하루 어땠어요? How was your day?');
});

$('btnKo').addEventListener('click', () => {
  if (S.mode === 'thinking') return;
  if (S.rec) { S.mode = 'idle'; stopListening(); }
  stopSpeech();
  S.started = true;
  // 듣기 언어 바꾸기 (한국어 ↔ 영어) 후 바로 듣기
  setListenLang(S.listenLang === 'en-US' ? 'ko-KR' : 'en-US');
  setTimeout(() => listen(), 150);
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

$('btDelay').value = S.btDelay;
const showBt = () => ($('btOut').textContent = (S.btDelay / 1000).toFixed(1) + '초');
showBt();
$('btDelay').addEventListener('input', (e) => {
  S.btDelay = Number(e.target.value);
  showBt();
  try { localStorage.setItem('btDelay', S.btDelay); } catch {}
});

$('aiVoice').addEventListener('change', async (e) => {
  await fetch('/api/voice', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: e.target.value }),
  }).catch(() => {});
  $('btnPreview').click();
});

$('model').addEventListener('change', async (e) => {
  const r = await fetch('/api/model', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: e.target.value }),
  }).catch(() => null);
  if (!r || !r.ok) addMsg('sys', '모드 변경 실패');
  checkServer();
});

// ------------------------------------------------------------------ 시작

async function checkServer() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    conn.textContent = '서버 연결됨 · ' + (s.model === 'haiku' ? '빠른 응답' : '꼼꼼한 교정');
    $('model').value = s.model;
    S.tts = !!s.tts;
    $('aiVoiceRow').hidden = !s.tts;
    if (s.tts && !$('aiVoice').options.length) {
      $('aiVoice').innerHTML = s.tts.voices.map((v) => '<option>' + v + '</option>').join('');
    }
    if (s.tts && document.activeElement !== $('aiVoice')) $('aiVoice').value = s.tts.voice;
    $('sysVoices').hidden = !!s.tts;
    conn.className = 'conn ok';
    showStats(s.totals);
    if (!S.serverUp) { S.serverUp = true; if (S.mode === 'idle' || S.mode === 'paused') setMode(S.mode, ''); }
  } catch {
    conn.textContent = '서버 꺼짐';
    conn.className = 'conn bad';
    S.serverUp = false;
    if (!S.rec && S.mode !== 'speaking') {
      orb.className = 'orb paused';
      orbLabel.innerHTML = '탭해서<br>서버 켜기';
      live.textContent = 'Termux가 잠깐 열렸다가 자동으로 돌아와요';
    }
  }
}
// 서버 켜기: Termux 를 열면 ~/.bashrc 가 서버를 켜고 이 앱을 다시 연다
function startServerViaTermux() {
  location.href = 'intent:#Intent;component=com.termux/.app.TermuxActivity;end';
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkServer());
checkServer();
setInterval(checkServer, 5000);
setListenLang('ko-KR');
setMode('idle', SR ? '' : '이 브라우저는 음성 인식을 지원하지 않아요. 크롬을 써주세요.');

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
