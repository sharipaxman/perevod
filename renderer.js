const $ = (id) => document.getElementById(id);
const apiKeyInput = $('apiKey');
const toggleButton = $('toggle');
const cutButton = $('cut');
const status = $('status');
const historyNode = $('history');
const emptyNode = $('empty');
const meterFill = $('meterFill');
const meterLabel = $('meterLabel');

// Пороги детектора речи (RMS уровня системного звука).
const BASE_THRESHOLD = 0.006;   // минимальный уровень, который считается речью
const NOISE_MULTIPLIER = 2.5;   // во сколько раз речь должна быть громче фонового шума
const SILENCE_HANG_MS = 900;    // сколько тишины после речи = конец фразы
const MIN_SEGMENT_MS = 700;     // короче этого не отправляем
const MAX_SEGMENT_MS = 14000;   // принудительная нарезка длинных монологов
const IDLE_RESET_MS = 12000;    // если речи не было — начинаем новый пустой сегмент
const NO_AUDIO_WARN_MS = 15000; // столько тишины в ноль = скорее всего звук не шарится

let stream = null;
let active = false;
let recorder = null;
let chunks = [];
let audioContext = null;
let analyser = null;
let analyserBuffer = null;
let sourceNode = null;
let monitorTimer = null;
let segmentStartedAt = 0;
let lastVoiceAt = 0;
let hasSpeech = false;
let noiseFloor = BASE_THRESHOLD / 2;
let peakSinceStart = 0;
let listeningStartedAt = 0;
let warnedAboutSilence = false;
let queue = Promise.resolve();
let pendingSegments = 0;
let lessonContext = [];
let contextScreenshot = null;

apiKeyInput.value = localStorage.getItem('openrouter-api-key') || localStorage.getItem('openai-api-key') || '';
$('language').value = localStorage.getItem('target-language') || 'Russian';
$('style').value = localStorage.getItem('reply-style') || 'friendly and conversational';
renderSavedHistory();
updateMeter(0);

apiKeyInput.addEventListener('change', () => localStorage.setItem('openrouter-api-key', apiKeyInput.value.trim()));
$('language').addEventListener('change', (event) => localStorage.setItem('target-language', event.target.value));
$('style').addEventListener('change', (event) => localStorage.setItem('reply-style', event.target.value));
toggleButton.addEventListener('click', () => (active ? stopListening() : startListening()));
cutButton.addEventListener('click', () => {
  if (!active) {
    showNotice('Сначала нажмите «Начать слушать».');
    return;
  }
  cutSegment('manual');
});

function clearHistory() {
  localStorage.removeItem('lesson-history');
  historyNode.innerHTML = '';
  emptyNode.hidden = false;
}

$('clear').addEventListener('click', clearHistory);

document.addEventListener('keydown', async (event) => {
  if (!event.ctrlKey || !event.shiftKey) return;
  event.preventDefault();
  if (event.code === 'KeyS') {
    try {
      contextScreenshot = await window.lessonAPI.screenshot();
      showNotice('Скриншот готов: он будет добавлен к следующим фразам.');
    } catch (error) {
      showError(error.message || 'Не удалось сделать скриншот.');
    }
  } else if (event.code === 'KeyC') {
    lessonContext = [];
    contextScreenshot = null;
    showNotice('Контекст модели очищен.');
  } else if (event.code === 'KeyH') {
    clearHistory();
    showNotice('История очищена.');
  }
});

async function startListening() {
  if (!apiKeyInput.value.trim()) {
    apiKeyInput.focus();
    showError('Сначала добавьте OpenRouter API key.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    stream.getVideoTracks().forEach((track) => track.stop());
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      throw new Error('Системный звук не был выбран. В окне захвата включите «Поделиться звуком системы».');
    }
    audioTracks[0].addEventListener('ended', () => {
      if (active) {
        stopListening();
        showNotice('Захват звука остановлен системой.');
      }
    });

    active = true;
    warnedAboutSilence = false;
    listeningStartedAt = Date.now();
    noiseFloor = BASE_THRESHOLD / 2;
    setLive(true);
    startMonitor(audioTracks);
    startRecorder();
  } catch (error) {
    stopListening();
    showError(error.message || 'Не удалось начать захват звука.');
  }
}

function stopListening() {
  active = false;
  stopMonitor();
  if (recorder && recorder.state !== 'inactive') {
    recorder.dataDiscarded = true;
    try { recorder.stop(); } catch { /* уже остановлен */ }
  }
  recorder = null;
  chunks = [];
  hasSpeech = false;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  updateMeter(0);
  setLive(false);
}

function setLive(isLive) {
  status.classList.toggle('live', isLive);
  status.querySelector('b').textContent = isLive ? 'Слушаю системный звук' : 'Остановлено';
  toggleButton.textContent = isLive ? 'Остановить' : 'Начать слушать';
  toggleButton.classList.toggle('stop', isLive);
}

/* ---------- Анализ уровня звука: именно он режет фразы ---------- */

function startMonitor(audioTracks) {
  audioContext = new AudioContext();
  if (audioContext.state === 'suspended') audioContext.resume();
  sourceNode = audioContext.createMediaStreamSource(new MediaStream(audioTracks));
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.2;
  analyserBuffer = new Float32Array(analyser.fftSize);
  sourceNode.connect(analyser);
  monitorTimer = setInterval(monitorTick, 100);
}

function stopMonitor() {
  clearInterval(monitorTimer);
  monitorTimer = null;
  try { sourceNode?.disconnect(); } catch { /* нечего отключать */ }
  sourceNode = null;
  analyser = null;
  analyserBuffer = null;
  audioContext?.close().catch(() => {});
  audioContext = null;
}

function currentLevel() {
  if (!analyser || !analyserBuffer) return 0;
  analyser.getFloatTimeDomainData(analyserBuffer);
  let sum = 0;
  for (let i = 0; i < analyserBuffer.length; i += 1) sum += analyserBuffer[i] * analyserBuffer[i];
  return Math.sqrt(sum / analyserBuffer.length);
}

function monitorTick() {
  if (!active) return;
  const now = Date.now();
  const level = currentLevel();
  peakSinceStart = Math.max(peakSinceStart, level);
  updateMeter(level);

  const threshold = Math.max(BASE_THRESHOLD, noiseFloor * NOISE_MULTIPLIER);
  if (level > threshold) {
    lastVoiceAt = now;
    hasSpeech = true;
    noiseFloor = noiseFloor * 0.995 + level * 0.005;
  } else {
    noiseFloor = noiseFloor * 0.9 + level * 0.1;
  }

  if (!warnedAboutSilence && peakSinceStart < 0.0015 && now - listeningStartedAt > NO_AUDIO_WARN_MS) {
    warnedAboutSilence = true;
    showError('Системный звук не поступает (уровень 0). Остановите и запустите захват заново, отметив «Поделиться звуком системы» / «Share system audio».');
  }

  if (!recorder || recorder.state !== 'recording') return;
  const elapsed = now - segmentStartedAt;
  if (hasSpeech && elapsed >= MIN_SEGMENT_MS && now - lastVoiceAt >= SILENCE_HANG_MS) {
    cutSegment('silence');
  } else if (hasSpeech && elapsed >= MAX_SEGMENT_MS) {
    cutSegment('max-length');
  } else if (!hasSpeech && elapsed >= IDLE_RESET_MS) {
    cutSegment('idle', true);
  }
}

function updateMeter(level) {
  if (!meterFill) return;
  const percent = Math.min(100, Math.round((level / 0.15) * 100));
  meterFill.style.width = `${percent}%`;
  meterFill.classList.toggle('hot', level > Math.max(BASE_THRESHOLD, noiseFloor * NOISE_MULTIPLIER));
  if (!meterLabel) return;
  if (!active) meterLabel.textContent = 'Уровень звука: —';
  else if (pendingSegments > 0) meterLabel.textContent = `Обрабатываю фразу… (${pendingSegments})`;
  else if (hasSpeech) meterLabel.textContent = 'Слышу речь, жду паузу…';
  else meterLabel.textContent = percent > 0 ? `Тишина (${percent}%)` : 'Тишина: звук не поступает';
}

/* ---------- Запись сегментов ---------- */

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function startRecorder() {
  if (!active || !stream) return;
  const audioStream = new MediaStream(stream.getAudioTracks());
  const mimeType = pickMimeType();
  chunks = [];
  hasSpeech = false;
  segmentStartedAt = Date.now();
  lastVoiceAt = 0;

  try {
    recorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);
  } catch (error) {
    showError(`Не удалось подготовить запись системного звука: ${error.message}`);
    stopListening();
    return;
  }

  recorder.dataDiscarded = false;
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  recorder.onerror = (event) => {
    showError(event.error?.message || 'Ошибка записи системного звука.');
    stopListening();
  };
  recorder.onstop = () => {
    const discarded = recorder?.dataDiscarded;
    const type = recorder?.mimeType || mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type });
    chunks = [];
    if (!discarded && blob.size > 2000) enqueue(blob);
    if (active) startRecorder();
  };

  try {
    recorder.start(500);
  } catch (error) {
    showError(`Не удалось начать запись системного звука: ${error.message}`);
    stopListening();
  }
}

function cutSegment(reason, discard = false) {
  if (!recorder || recorder.state !== 'recording') return;
  console.log(`Сегмент закрыт: ${reason}, длительность ${Date.now() - segmentStartedAt} мс`);
  recorder.dataDiscarded = discard;
  try {
    recorder.stop();
  } catch (error) {
    console.error('stop error', error);
  }
}

function enqueue(blob) {
  pendingSegments += 1;
  updateMeter(0);
  queue = queue
    .then(() => processAudio(blob))
    .catch((error) => showError(error.message || 'Не удалось обработать аудио.'))
    .finally(() => {
      pendingSegments = Math.max(0, pendingSegments - 1);
    });
}

async function processAudio(blob) {
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  const text = await window.lessonAPI.transcribe({ bytes, mimeType: blob.type });
  if (!text || text.trim().length < 2) return;

  const result = await window.lessonAPI.assist({
    apiKey: apiKeyInput.value.trim(),
    text,
    targetLanguage: $('language').value,
    replyStyle: $('style').value,
    context: lessonContext,
    screenshot: contextScreenshot
  });

  const userContent = [{ type: 'text', text }];
  if (contextScreenshot) {
    userContent[0].text = `This spoken phrase should be interpreted using the saved lesson screenshot as context:\n${text}`;
    userContent.push({ type: 'image_url', image_url: { url: contextScreenshot } });
  }
  lessonContext.push(
    { role: 'user', content: userContent },
    { role: 'assistant', content: JSON.stringify(result) }
  );
  lessonContext = lessonContext.slice(-8);
  addEntry({ text, translation: result.translation, replies: result.replies, at: new Date().toISOString() });
}

/* ---------- История и уведомления ---------- */

function addEntry(entry, save = true) {
  emptyNode.hidden = true;
  const card = $('entryTemplate').content.firstElementChild.cloneNode(true);
  card.querySelector('.entry-time').textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  card.querySelector('.heard p').textContent = entry.text;
  card.querySelector('.translation p').textContent = entry.translation;
  const replies = card.querySelector('.replies');
  (entry.replies || []).forEach((reply) => {
    const row = document.createElement('div');
    row.className = 'reply';
    const phrase = document.createElement('span');
    phrase.textContent = reply;
    const copy = document.createElement('button');
    copy.textContent = 'Копировать';
    copy.onclick = async () => {
      await navigator.clipboard.writeText(reply);
      copy.textContent = 'Готово';
      setTimeout(() => (copy.textContent = 'Копировать'), 1000);
    };
    row.append(phrase, copy);
    replies.append(row);
  });
  historyNode.prepend(card);
  if (save) {
    const items = getHistory();
    items.unshift(entry);
    localStorage.setItem('lesson-history', JSON.stringify(items.slice(0, 100)));
  }
}

function showError(message) {
  emptyNode.hidden = true;
  const card = document.createElement('article');
  card.className = 'entry panel error';
  card.textContent = message;
  historyNode.prepend(card);
}

function showNotice(message) {
  status.querySelector('b').textContent = message;
  setTimeout(() => {
    status.querySelector('b').textContent = active ? 'Слушаю системный звук' : 'Остановлено';
  }, 2500);
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem('lesson-history') || '[]'); }
  catch { return []; }
}

function renderSavedHistory() {
  const items = getHistory();
  items.slice().reverse().forEach((item) => addEntry(item, false));
}
