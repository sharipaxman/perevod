const $ = (id) => document.getElementById(id);
const apiKeyInput = $('apiKey');
const toggleButton = $('toggle');
const status = $('status');
const historyNode = $('history');
const emptyNode = $('empty');

let stream = null;
let active = false;
let recording = false;
let timer = null;
let recorder = null;
let bufferStart = null;
let lastAudioTime = null;
let silenceDuration = 0;
let lessonContext = [];
let contextScreenshot = null;

apiKeyInput.value = localStorage.getItem('openrouter-api-key') || localStorage.getItem('openai-api-key') || '';
$('language').value = localStorage.getItem('target-language') || 'Russian';
$('style').value = localStorage.getItem('reply-style') || 'friendly and conversational';
renderSavedHistory();

apiKeyInput.addEventListener('change', () => localStorage.setItem('openrouter-api-key', apiKeyInput.value.trim()));
$('language').addEventListener('change', (event) => localStorage.setItem('target-language', event.target.value));
$('style').addEventListener('change', (event) => localStorage.setItem('reply-style', event.target.value));
toggleButton.addEventListener('click', () => active ? stopListening() : startListening());
$('cut').addEventListener('click', () => {
  if (recording && recorder) {
    console.log('Manual cut triggered');
    recorder.stop();
  }
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
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((track) => track.stop());
    if (!stream.getAudioTracks().length) throw new Error('Системный звук не был выбран. Включите передачу аудио в окне захвата.');
    active = true;
    setLive(true);
    recordSegment();
  } catch (error) {
    stopListening();
    showError(error.message || 'Не удалось начать захват звука.');
  }
}

function stopListening() {
  active = false;
  clearTimeout(timer);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  setLive(false);
}

function setLive(isLive) {
  status.classList.toggle('live', isLive);
  status.querySelector('b').textContent = isLive ? 'Слушаю системный звук' : 'Остановлено';
  toggleButton.textContent = isLive ? 'Остановить' : 'Начать слушать';
  toggleButton.classList.toggle('stop', isLive);
}

function recordSegment() {
  if (!active || recording || !stream) return;
  recording = true;
  const chunks = [];
  const audioStream = new MediaStream(stream.getAudioTracks());
  const mimeTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    ''
  ];
  const mimeType = mimeTypes.find((type) => !type || MediaRecorder.isTypeSupported(type));
  try {
    recorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);
  } catch (error) {
    recording = false;
    showError(`Не удалось подготовить запись системного звука: ${error.message}`);
    console.error('Recorder setup error:', error);
    stopListening();
    return;
  }
  recorder.ondataavailable = (event) => {
    if (event.data.size) {
      chunks.push(event.data);
      lastAudioTime = Date.now();
      console.log('Audio chunk:', event.data.size, 'bytes');
    }
  };
  recorder.onerror = (event) => {
    recording = false;
    showError(event.error?.message || 'Ошибка записи системного звука. Проверьте, что звук включён в окне захвата.');
    console.error('Recorder error:', event.error);
    stopListening();
  };
  recorder.onstop = async () => {
    console.log('Recorder stopped, chunks:', chunks.length);
    recording = false;
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
    console.log('Blob size:', blob.size, 'bytes');
    if (blob.size > 1000) await processAudio(blob);
    if (active) timer = setTimeout(recordSegment, 100);
  };
  try {
    recorder.start(250);
    console.log('Recorder started');
  } catch (error) {
    recording = false;
    showError(`Не удалось начать запись системного звука: ${error.message}`);
    console.error('Recorder start error:', error);
    stopListening();
    return;
  }
  timer = setInterval(() => {
    if (!active || !lastAudioTime) return;
    silenceDuration = Date.now() - lastAudioTime;
    if (silenceDuration > 1500) {
      console.log('Silence detected:', silenceDuration, 'ms');
      clearInterval(timer);
      recorder.stop();
    }
  }, 100);
}

async function processAudio(blob) {
  console.log('Processing audio...');
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    console.log('Sending transcription request...');
    const text = await window.lessonAPI.transcribe({ apiKey: apiKeyInput.value.trim(), bytes, mimeType: blob.type });
    console.log('Transcribed text:', text);
    if (!text || text.length < 1) return;
    console.log('Sending assist request...');
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
  } catch (error) {
    showError(error.message || 'Не удалось обработать аудио.');
  }
}

function addEntry(entry, save = true) {
  emptyNode.hidden = true;
  const card = $('entryTemplate').content.firstElementChild.cloneNode(true);
  card.querySelector('.entry-time').textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  card.querySelector('.heard p').textContent = entry.text;
  card.querySelector('.translation p').textContent = entry.translation;
  const replies = card.querySelector('.replies');
  entry.replies.forEach((reply) => {
    const row = document.createElement('div');
    row.className = 'reply';
    const phrase = document.createElement('span');
    phrase.textContent = reply;
    const copy = document.createElement('button');
    copy.textContent = 'Копировать';
    copy.onclick = async () => {
      await navigator.clipboard.writeText(reply);
      copy.textContent = 'Готово';
      setTimeout(() => copy.textContent = 'Копировать', 1000);
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
  const wasLive = active;
  status.querySelector('b').textContent = message;
  setTimeout(() => {
    if (wasLive && active) status.querySelector('b').textContent = 'Слушаю системный звук';
    else if (!active) status.querySelector('b').textContent = 'Остановлено';
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
