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
  needWake: false,
  phase: 'home',         // home | lesson | wrapping | result
  lessonEndAt: 0,        // 10분 수업이 끝나는 시각
  timeUp: false,
  endSilence: Number(localStorage.getItem('endSilence') ?? 2500), // 말을 멈춘 뒤 이만큼 조용하면 끝난 걸로 (ms)
  sttServer: false,      // 서버 음성 인식(Google/Whisper) 사용 가능 여부
};
const LESSON_MS = 10 * 60 * 1000;
const SUBJECT_INFO = {
  en: { title: '🇺🇸 영어 회화', lang: 'en-US', flag: '🇺🇸', name: '영어', tag: 'en', preview: '안녕하세요! 오늘 하루 어땠어요? How was your day?' },
  ja: { title: '🇯🇵 일본어 회화', lang: 'ja-JP', flag: '🇯🇵', name: '일본어', tag: 'ja', preview: '안녕하세요! 오늘 하루 어땠어요? 今日はどうでしたか?' },
};
S.subject = 'en';
const target = () => SUBJECT_INFO[S.subject] || SUBJECT_INFO.en;

// ------------------------------------------------------------------ UI

const LABELS = {
  idle: '탭해서<br>말하기',
  listening: '듣는 중…<br><small>다 말했으면 탭</small>',
  thinking: '생각 중…',
  speaking: '말하는 중<br><small>탭하면 끊기</small>',
  paused: '일시정지<br><small>탭해서 계속</small>',
  error: '오류<br><small>탭해서 재시도</small>',
};

function setMode(mode, liveText) {
  S.mode = mode;
  orb.className = 'orb ' + mode;
  orbLabel.innerHTML = LABELS[mode];
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
  if (document.visibilityState === 'visible' && S.phase === 'lesson') keepAwake();
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
    const kind = HANGUL.test(ch) ? 'ko' : /[A-Za-z]/.test(ch) ? 'en' : /[\u3040-\u30FF\u4E00-\u9FFF]/.test(ch) ? 'ja' : null;
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
    await speakOne(part.text, { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' }[part.kind], rateMul);
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

// ---- Gemini AI 음성: 서버(/api/tts)가 PCM 을 흘려주면 받는 대로 바로 재생.
// 실패하면 폰 기본 음성으로 읽는다.
const TTS_RATE = 24000;

// 음성 받기 시작 (재생 순서가 오기 전에 미리 받아두기 위해 바로 시작)
function startTTS(text) {
  if (!S.tts) return null;
  const h = { chunks: [], done: false, failed: false, error: '', notify: null };
  const wake = () => { const f = h.notify; h.notify = null; f && f(); };
  fetch('/api/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  }).then(async (r) => {
    if (!r.ok || !r.body) {
      const j = await r.json().catch(() => ({}));
      throw new Error(r.status === 429 ? j.error : 'AI 음성 오류라 기본 음성으로 읽어요');
    }
    const reader = r.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      h.chunks.push(value);
      wake();
    }
  }).catch((err) => { if (!h.chunks.length) { h.failed = true; h.error = err.message; } })
    .finally(() => { h.done = true; wake(); });
  return h;
}

// 받은 PCM 조각들을 끊김 없이 이어서 재생. 반환값 false = 음성을 못 받음(폰 음성으로 대체)
function playTTS(h, rateMul) {
  unlockAudio();
  return new Promise((resolve) => {
    const ctx = audioCtx;
    const rate = Math.min(1.4, Math.max(0.6, (S.rate / 0.85) * rateMul));
    const sources = [];
    let nextTime = 0, carry = null, idx = 0, played = false, stopped = false, ended = 0;
    let finished = false;
    const finish = (ok) => { if (finished) return; finished = true; if (S.ttsStop === stop) S.ttsStop = null; resolve(ok); };
    const stop = () => { stopped = true; sources.forEach((src) => { try { src.stop(); } catch {} }); finish(true); };
    S.ttsStop = stop;

    const schedule = (bytes) => {
      if (carry) { const m = new Uint8Array(carry.length + bytes.length); m.set(carry); m.set(bytes, carry.length); bytes = m; carry = null; }
      if (bytes.length % 2) { carry = bytes.slice(-1); bytes = bytes.slice(0, -1); }
      const n = bytes.length / 2;
      if (!n) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      const audio = ctx.createBuffer(1, n, TTS_RATE);
      const ch = audio.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.playbackRate.value = rate;
      src.connect(ctx.destination);
      // 처음엔 0.25초 여유를 두고 시작 → 네트워크가 조금 늦어도 끊기지 않게
      if (!played) { nextTime = ctx.currentTime + 0.25; played = true; }
      if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.05;
      src.start(nextTime);
      nextTime += audio.duration / rate;
      sources.push(src);
      src.onended = () => { ended++; if (h.done && ended === sources.length && idx >= h.chunks.length && !stopped) finish(true); };
    };

    const pump = () => {
      if (stopped) return;
      while (idx < h.chunks.length) schedule(h.chunks[idx++]);
      if (h.done) {
        if (!played) return finish(false); // 하나도 못 받음
        if (ended === sources.length) return finish(true);
        // 안전장치: 재생 끝 알림이 안 와도 예정 시간이 지나면 다음으로 넘어간다
        setTimeout(() => !stopped && finish(true), Math.max(0, nextTime - ctx.currentTime) * 1000 + 1500);
        return; // 남은 소리가 끝나면 onended 에서 finish
      }
      h.notify = pump;
    };
    if (!ctx) return finish(false);
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    pump();
  });
}

async function speakText(text, rateMul = 1, handle) {
  const h = handle || startTTS(text);
  if (h && (await playTTS(h, rateMul))) return;
  // AI 음성을 못 쓰면 이유를 한 번 알려주고 폰 기본 음성으로 읽기
  if (h?.error && S.ttsNotice !== h.error) {
    S.ttsNotice = h.error;
    addMsg('sys', '🔈 ' + h.error);
  }
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
  S.speakQueue.push({ text, audio: startTTS(text) });
  pumpSpeech();
}

function stopSpeech() {
  S.speakQueue = [];
  synth && synth.cancel();
  S.ttsStop?.();
}

function afterSpeech() {
  setMode('idle', '');
  if (S.phase === 'wrapping') return finishLesson();
  if (S.phase !== 'lesson') return;
  if (S.timeUp) return wrapUp();
  if (S.handsFree) setTimeout(() => S.mode === 'idle' && S.phase === 'lesson' && listen(), 250);
}

// 선생님 답 끝의 [[en]] / [[ko]] = 학생이 다음에 말할 언어
const LANG_TAG = /\[\[(en|ko|ja)\]\]/g;
const stripTags = (t) => t.replace(LANG_TAG, '').replace(/\[\[?[a-z]{0,2}\]?$/, '');

function setListenLang(lang) {
  S.listenLang = lang;
  const b = $('btnKo');
  const names = { 'ko-KR': ['🇰🇷', '한국어로 듣는 중'], 'en-US': ['🇺🇸', '영어로 듣는 중'], 'ja-JP': ['🇯🇵', '일본어로 듣는 중'] };
  const [flag, label] = names[lang] || names['ko-KR'];
  b.firstChild.textContent = flag;
  b.querySelector('span').textContent = label;
}

// ------------------------------------------------------------------ 음성 인식 (STT)

function listen(lang = S.listenLang) {
  if (S.sttServer && navigator.mediaDevices?.getUserMedia && window.MediaRecorder) return listenRecord(lang);
  return listenBrowser(lang);
}

// ---- 직접 녹음: 말을 멈춰도 S.endSilence 동안은 기다려준다 (초보는 생각하면서 말하니까)
async function listenRecord(lang = S.listenLang) {
  stopSpeech();
  unlockAudio();
  setMode('listening', '마이크 준비 중…');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    setMode('error', '마이크 권한이 필요해요. 주소창 왼쪽 자물쇠 → 권한 → 마이크 허용');
    return;
  }
  const rec = new MediaRecorder(stream, MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : {});
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  // 소리 크기로 "말하는 중 / 조용함" 판단 (주변 소음에 맞춰 기준을 자동으로 잡음)
  const src = audioCtx.createMediaStreamSource(stream);
  const an = audioCtx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const t0 = Date.now();
  let floor = 0.01, floorN = 0, spoke = false, speechMs = 0, lastVoice = 0, done = false;

  const ctl = { stop: (send) => finish(send) };
  S.rec = ctl;

  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    if (now - t0 < 400) { floor = (floor * floorN + rms) / ++floorN; return; } // 처음 0.4초: 주변 소음 측정
    const loud = rms > Math.max(0.02, floor * 3);
    if (loud) {
      speechMs += 50;
      lastVoice = now;
      if (speechMs >= 200) spoke = true;
    } else if (!spoke) {
      floor = floor * 0.98 + rms * 0.02;
    }
    if (spoke) {
      const quiet = now - lastVoice;
      if (quiet > 600) {
        const left = Math.max(0, S.endSilence - quiet);
        live.textContent = `조용하면 ${(left / 1000).toFixed(1)}초 뒤 보내요 · 계속 말해도 돼요`;
      } else {
        live.textContent = '듣고 있어요… 천천히 말해도 기다려요';
      }
      if (quiet >= S.endSilence) finish(true);
    } else if (now - t0 > 10000) {
      finish(false); // 10초 동안 아무 말 없음
    }
    if (now - t0 > 45000) finish(true); // 너무 길면 끊어서 보냄
  }, 50);

  function finish(send) {
    if (done) return;
    done = true;
    clearInterval(timer);
    if (S.rec === ctl) S.rec = null;
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop()); // 마이크를 바로 놓아줘야 블루투스 음질이 돌아온다
      try { src.disconnect(); } catch {}
      handleRecording(send && spoke ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null, lang);
    };
    try { rec.stop(); } catch { rec.onstop(); }
  }

  rec.start(250);
  setMode('listening', lang === 'ko-KR' ? '말해보세요… 천천히 해도 기다려요' : `${target().name}로 말해보세요… 천천히 해도 기다려요`);
}

async function handleRecording(blob, lang) {
  if (S.phase !== 'lesson' && S.phase !== 'wrapping') return;
  if (!blob) {
    // 아무 말도 없었음
    if (S.mode !== 'listening') return; // 사용자가 직접 멈춤
    if (S.timeUp) { setMode('idle', ''); return wrapUp(); }
    S.silentTries += 1;
    if (S.handsFree && S.silentTries < 4) return listen(lang);
    S.silentTries = 0;
    return setMode('paused', '조용해서 잠깐 쉬어요. 동그라미를 누르면 다시 들어요.');
  }
  S.silentTries = 0;
  setMode('thinking', '알아듣는 중…');
  try {
    const r = await fetch('/api/stt', {
      method: 'POST',
      headers: { 'Content-Type': blob.type, 'X-Lang': { 'en-US': 'en', 'ja-JP': 'ja' }[lang] || 'ko' },
      body: blob,
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'stt ' + r.status);
    if (!j.text) {
      addMsg('sys', '잘 못 들었어요. 한 번만 다시 말해 주세요');
      return listen(lang);
    }
    ask(j.text, { pron: j.pron });
  } catch (err) {
    // 서버 인식이 안 되면 이번 수업은 크롬 기본 인식으로
    S.sttServer = false;
    addMsg('sys', '🎙 음성 인식 서버 문제로 기본 인식으로 바꿨어요. 다시 말해 주세요');
    listenBrowser(lang);
  }
}

function listenBrowser(lang = S.listenLang) {
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
    if (S.timeUp) { setMode('idle', ''); return wrapUp(); } // 시간 끝 + 조용함 → 마무리
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
  if (!S.rec) return;
  const r = S.rec;
  if (r.abort) r.stop(); // 크롬 기본 인식
  else r.stop(false);    // 직접 녹음: 보내지 않고 멈춤
}

// ------------------------------------------------------------------ 서버 대화

async function ask(text, { hidden = false, pron = '' } = {}) {
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
      body: JSON.stringify({ text, pron }),
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
    const lastTag = tags.length ? tags[tags.length - 1][1] : 'ko';
    setListenLang(lastTag === 'ko' ? 'ko-KR' : target().lang);
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
    if (S.phase === 'wrapping') finishLesson(); // 마무리 인사가 실패해도 평가는 진행
  }
}

// ------------------------------------------------------------------ 버튼

orb.addEventListener('click', () => {
  if (S.serverUp === false) return startServerViaTermux();
  if (S.phase !== 'lesson') return;
  switch (S.mode) {
    case 'speaking': stopSpeech(); listen(); break;          // 말 끊고 바로 내 차례
    case 'listening': if (S.rec?.stop) S.rec.stop(true); else { S.mode = 'idle'; stopListening(); setMode('idle', ''); } break;
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
  await speakText(target().preview);
});

$('btnKo').addEventListener('click', () => {
  if (S.mode === 'thinking') return;
  if (S.rec) { S.mode = 'idle'; stopListening(); }
  stopSpeech();
  // 듣기 언어 바꾸기 (한국어 ↔ 영어) 후 바로 듣기
  setListenLang(S.listenLang === 'ko-KR' ? target().lang : 'ko-KR');
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

// ------------------------------------------------------------------ 화면 / 수업 흐름

function showScreen(name) {
  for (const id of ['home', 'lesson', 'result', 'review']) $(id).hidden = id !== name;
  window.scrollTo(0, 0);
}

const LEVEL_DESC_JA = [
  '', '인사말이나 단어 몇 개', 'はじめまして 같은 정해진 짧은 문장', 'です・ます로 내 얘기 조금 (N5 초반)',
  '과거형도 쓰지만 조사·활용 실수가 많음 (N5)', '쉬운 질문에 2~3문장으로 대답 (N4 초반)', 'て형으로 잇고 から로 이유를 말함 (N4)',
  '경험과 계획을 말함 (N3 초반)', '내 의견을 자연스럽게 (N3)', '긴 대화를 스스로 이어감 (N2)', '원어민과 자유로운 일상 대화 (N1)',
];
const levelDesc = (lv) => (S.subject === 'ja' ? LEVEL_DESC_JA : LEVEL_DESC)[lv] || '';
const LEVEL_DESC = [
  '', '영어 인사나 단어 몇 개', '아주 짧은 정해진 문장', '현재형 짧은 문장으로 내 얘기',
  '과거형도 쓰지만 실수가 많음', '쉬운 질문에 2~3문장으로 대답', '이유를 말하고 시제가 대체로 맞음',
  '경험과 계획을 말함', '내 의견을 자연스럽게', '긴 대화를 스스로 이어감', '원어민과 자유로운 일상 대화',
];

function esc(t) { return String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function loadHome() {
  try {
    const p = await (await fetch('/api/progress')).json();
    const lv = p.plan.level;
    $('levelNum').textContent = lv ?? '-';
    $('levelBar').innerHTML = Array.from({ length: 10 }, (_, i) => `<i class="${lv && i < lv ? 'on' : ''}"></i>`).join('');
    $('levelDesc').textContent = lv ? levelDesc(lv) : '첫 수업에서 레벨을 알아봐요';
    $('nextLabel').textContent = `${p.plan.lessonNo}번째 수업 · 오늘의 주제`;
    $('nextFocus').textContent = p.plan.focus;
    const rv = p.reviews || { due: 0, total: 0 };
    $('reviewInfo').textContent = rv.total
      ? `오늘 복습할 문장 ${rv.due}개 · 전체 ${rv.total}개 (수업 처음에 선생님이 다시 시켜요)`
      : '수업에서 틀린 문장이 여기에 모이고, 잊어버릴 때쯤 다시 복습해요';
    $('btnListen').disabled = !rv.total;
    $('history').innerHTML = p.lessons.length
      ? p.lessons.map((l) => `<div class="h-item"><div class="h-top"><span>${esc(l.date)}</span><span class="h-level">레벨 ${l.level}</span></div><div class="h-sum">${esc(l.summary)}</div></div>`).join('')
      : '<div class="empty">아직 수업 기록이 없어요</div>';
    S.plan = p.plan;
    if (p.plan.subject) S.subject = p.plan.subject;
    $('appTitle').textContent = target().title;
    document.querySelectorAll('[data-subject]').forEach((b) => b.classList.toggle('on', b.dataset.subject === S.subject));
  } catch {}
}

async function startLesson() {
  if (S.serverUp === false) return startServerViaTermux();
  unlockAudio();
  if (synth) synth.speak(new SpeechSynthesisUtterance('')); // 모바일 음성 잠금 해제 (첫 터치 때)
  keepAwake();
  const plan = await (await fetch('/api/lesson/start', { method: 'POST' })).json().catch(() => S.plan || {});
  log.innerHTML = '';
  S.lastReply = '';
  S.handsFree = true;
  S.timeUp = false;
  S.phase = 'lesson';
  S.lessonEndAt = Date.now() + LESSON_MS;
  setListenLang('ko-KR');
  $('lessonTitle').textContent = `${plan.lessonNo || ''}번째 수업`;
  showScreen('lesson');
  tickTimer();
  ask(`[수업 시작. ${plan.lessonNo}번째 수업이야. 한국어로 짧게 반갑게 인사하고, 지난 수업 기록이 있으면 짧게 복습한 뒤, 오늘의 주제로 아주 쉬운 ${target().name} 질문 하나를 해.]`, { hidden: true });
}

function tickTimer() {
  if (S.phase !== 'lesson' && S.phase !== 'wrapping') return;
  const left = Math.max(0, S.lessonEndAt - Date.now());
  const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
  $('timer').textContent = `${m}:${String(sec).padStart(2, '0')}`;
  $('timer').classList.toggle('low', left < 60000);
  if (!left && !S.timeUp && S.phase === 'lesson') {
    S.timeUp = true;
    // 지금 말하거나 생각 중이면 그게 끝난 뒤 마무리, 쉬는 중이면 바로 마무리
    if (S.mode === 'idle' || S.mode === 'paused' || S.mode === 'error') wrapUp();
    else if (S.mode === 'listening') addMsg('sys', '⏰ 10분이 됐어요. 이번 대답 뒤에 마무리해요');
  }
}
setInterval(tickTimer, 1000);

// 수업 마무리: 선생님이 오늘 수업을 정리해서 말하게 하고, 다 말하면 평가
function wrapUp() {
  if (S.phase !== 'lesson') return;
  S.phase = 'wrapping';
  if (S.rec) { S.mode = 'idle'; stopListening(); }
  stopSpeech();
  ask('[수업 시간 끝. 오늘 잘한 점 하나와 다음에 고칠 점 하나를 한국어로 짧게 말하고, 다음 수업에서 만나자고 마무리 인사해. 질문은 하지 마.]', { hidden: true });
}

async function finishLesson() {
  S.phase = 'result';
  S.handsFree = false;
  try { S.wakeLock?.release(); } catch {}
  showScreen('result');
  $('resultBody').innerHTML = '<div class="loading">선생님이 오늘 수업을 평가하고 있어요…</div>';
  const prevLevel = S.plan?.level;
  let data = null;
  try { data = await (await fetch('/api/lesson/end', { method: 'POST' })).json(); } catch {}
  const ev = data?.evaluation;
  if (!ev) {
    $('resultBody').innerHTML = '<div class="card"><p>대화가 짧아서 이번 수업은 평가하지 않았어요.</p></div>';
    loadHome();
    return;
  }
  const diff = prevLevel ? ev.level - prevLevel : null;
  const change = diff == null ? '첫 레벨 측정' : diff > 0 ? `지난번보다 ${diff} 올랐어요 🎉` : diff < 0 ? `지난번보다 ${-diff} 내려갔어요` : '지난번과 같아요';
  $('resultBody').innerHTML = `
    <div class="card result-level">
      <div class="label">오늘 레벨</div>
      <div class="big">${ev.level} <span class="level-max">/ 10</span></div>
      <div class="change ${diff > 0 ? 'up' : ''}">${change}</div>
      <div class="level-desc">${esc(levelDesc(ev.level))}</div>
    </div>
    <div class="card">
      <div class="r-sec"><div class="label">오늘 한 것</div><p>${esc(ev.summary)}</p></div>
      <div class="r-sec"><div class="label">👍 잘한 점</div><p>${esc(ev.good)}</p></div>
      <div class="r-sec"><div class="label">✏️ 고칠 점</div><p>${esc(ev.improve)}</p></div>
      ${ev.mistakes?.length ? `<div class="r-sec"><div class="label">틀린 문장 → 맞는 문장 (복습 목록에 추가됐어요)</div><ul>${ev.mistakes.map((m) => typeof m === 'string' ? `<li>${esc(m)}</li>` : `<li>${esc(m.wrong)} → <b>${esc(m.right)}</b>${m.meaning ? ` <span class="muted">(${esc(m.meaning)})</span>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${ev.reviewed?.length ? `<div class="r-sec"><div class="label">오늘 복습한 문장</div><ul>${ev.reviewed.map((r) => `<li>${r.ok ? '✅' : '🔁'} ${esc(r.right)}</li>`).join('')}</ul></div>` : ''}
      <div class="r-sec"><div class="label">다음 수업</div><p>${esc(ev.next_focus)}</p></div>
    </div>`;
  loadHome();
}

$('btnStart').addEventListener('click', startLesson);

// ---- 듣기 복습: 한국어 뜻 → (내가 말해볼 시간) → 맞는 문장 → 천천히 한 번 더
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function startListenReview() {
  const { items } = await (await fetch('/api/review/list')).json().catch(() => ({ items: [] }));
  if (!items?.length) return alert('아직 복습할 문장이 없어요. 수업을 먼저 해보세요!');
  unlockAudio();
  keepAwake();
  S.phase = 'review';
  S.reviewPaused = false;
  S.reviewSkip = false;
  showScreen('review');
  const say = async (text, rate = 1) => { if (S.phase === 'review') await speakText(text, rate); };
  const pause = async (ms) => {
    const until = Date.now() + ms;
    while (S.phase === 'review' && !S.reviewSkip && (Date.now() < until || S.reviewPaused)) await wait(100);
  };
  await wakeAudio();
  await say(`듣기 복습을 시작할게요. 한국어 뜻을 들으면, 먼저 ${target().name}로 말해보세요.`);
  for (let i = 0; i < items.length && S.phase === 'review'; i++) {
    const it = items[i];
    S.reviewSkip = false;
    $('rvCount').textContent = `${i + 1} / ${items.length}`;
    // 뜻이 저장돼 있으면 "뜻 → 말해보기", 없으면(예전 기록) "틀렸던 말 → 고쳐서 말해보기"
    $('rvLabel').textContent = it.meaning ? '뜻' : '예전에 틀렸던 말';
    $('rvMeaning').textContent = it.meaning || it.wrong;
    $('rvRight').textContent = '';
    $('rvHint').textContent = it.meaning ? '먼저 말해보세요…' : '맞게 고쳐서 말해보세요…';
    await say(it.meaning ? it.meaning : `예전에 이렇게 말했어요. ${it.wrong}. 맞게 고쳐서 말해보세요.`);
    await pause(3500);
    if (S.phase !== 'review') break;
    $('rvRight').textContent = it.right;
    $('rvHint').textContent = '정답';
    if (!S.reviewSkip) await say(it.right);
    await pause(1500);
    $('rvHint').textContent = '천천히 한 번 더';
    if (!S.reviewSkip) await say(it.right, 0.8);
    await pause(1500);
  }
  if (S.phase === 'review') {
    await say('오늘 듣기 복습 끝! 수고했어요.');
    endListenReview();
  }
}
function endListenReview() {
  S.phase = 'home';
  stopSpeech();
  try { S.wakeLock?.release(); } catch {}
  showScreen('home');
  loadHome();
}
$('btnListen').addEventListener('click', startListenReview);
$('rvStop').addEventListener('click', endListenReview);
$('rvPause').addEventListener('click', () => {
  S.reviewPaused = !S.reviewPaused;
  $('rvPause').querySelector('span').textContent = S.reviewPaused ? '계속' : '일시정지';
  if (S.reviewPaused) stopSpeech();
});
$('rvNext').addEventListener('click', () => { S.reviewSkip = true; stopSpeech(); });
document.querySelectorAll('[data-subject]').forEach((b) => b.addEventListener('click', async () => {
  if (b.dataset.subject === S.subject) return;
  S.subject = b.dataset.subject;
  document.querySelectorAll('[data-subject]').forEach((x) => x.classList.toggle('on', x === b));
  await fetch('/api/subject', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: S.subject }),
  }).catch(() => {});
  loadHome();
}));
$('btnHome').addEventListener('click', () => { S.phase = 'home'; showScreen('home'); loadHome(); });
$('btnEnd').addEventListener('click', () => {
  if (S.phase !== 'lesson') return;
  if (!confirm('수업을 지금 끝낼까요? 선생님이 마무리하고 평가해요.')) return;
  wrapUp();
});

// 설정 창: ⚙ 로 열고, ✕ 또는 바깥을 누르면 닫기
$('btnSettings').addEventListener('click', () => { $('sheet').hidden = false; });
document.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => { $('sheet').hidden = true; }));

$('endSilence').value = S.endSilence;
const showSil = () => ($('silOut').textContent = (S.endSilence / 1000).toFixed(1) + '초');
showSil();
$('endSilence').addEventListener('input', (e) => {
  S.endSilence = Number(e.target.value);
  showSil();
  try { localStorage.setItem('endSilence', S.endSilence); } catch {}
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
    conn.textContent = '● 준비됨 · ' + (s.model === 'haiku' ? '빠른 응답 모드' : '꼼꼼한 교정 모드');
    $('model').value = s.model;
    S.tts = !!s.tts;
    $('aiVoiceRow').hidden = !s.tts;
    if (s.tts && !$('aiVoice').options.length) {
      $('aiVoice').innerHTML = s.tts.voices.map((v) => '<option>' + v + '</option>').join('');
    }
    if (s.tts && document.activeElement !== $('aiVoice')) $('aiVoice').value = s.tts.voice;
    $('sysVoices').hidden = !!s.tts;
    S.sttServer = !!s.stt?.engines?.length;
    const sttName = { gemini: 'Gemini', google: 'Google', whisper: 'Whisper(폰)' };
    $('sttInfo').textContent = s.stt
      ? `음성 인식: ${s.stt.engines.map((e) => sttName[e]).join(' → ') || '크롬 기본'}` +
        (s.stt.googleSeconds != null ? ` · Google 이번 달 ${Math.floor(s.stt.googleSeconds / 60)} / ${Math.floor(s.stt.googleLimit / 60)}분 (넘으면 Whisper)` : '')
      : '';
    $('ttsUsage').textContent = s.tts?.used != null
      ? `AI 음성 이번 달 ${s.tts.used.toLocaleString()} / ${s.tts.limit.toLocaleString()}자 (넘으면 자동으로 기본 음성)`
      : '';
    conn.className = 'conn ok';
    showStats(s.totals);
    if (!S.serverUp) {
      S.serverUp = true;
      if (S.phase === 'lesson' && (S.mode === 'idle' || S.mode === 'paused')) setMode(S.mode, '');
      $('btnStart').textContent = '▶ 10분 수업 시작';
      $('btnStart').classList.remove('off');
      loadHome();
    }
  } catch {
    conn.textContent = '서버 꺼짐';
    conn.className = 'conn bad';
    S.serverUp = false;
    $('btnStart').textContent = '서버 켜기 (Termux가 잠깐 열려요)';
    $('btnStart').classList.add('off');
    if (S.phase === 'lesson' && !S.rec && S.mode !== 'speaking') {
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
loadHome();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
