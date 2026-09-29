const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const readline = require('readline');
const path = require('path');

const INCEPTION_API_BASE_URL = (process.env.INCEPTION_API_BASE_URL || 'https://api.inceptionlabs.ai/v1').replace(/\/+$/, '');
const CHAT_COMPLETIONS_URL = `${INCEPTION_API_BASE_URL}/chat/completions`;
const ASSIST_MODEL = process.env.ASSIST_MODEL || 'mercury-2.5';
const ASSIST_REASONING_EFFORT = process.env.ASSIST_REASONING_EFFORT || 'none';
const TRANSCRIBE_TIMEOUT_MS = 120000;

let transcriber = null;
let transcriberStarting = null;
let transcriberRequestId = 0;
const transcriberPending = new Map();
let transcriberLog = [];

function rememberTranscriberLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) transcriberLog.push(trimmed);
  }
  transcriberLog = transcriberLog.slice(-25);
}

function describeTranscriberFailure(fallback) {
  const log = transcriberLog.join('\n');
  if (/No module named ['"]?faster_whisper/i.test(log)) {
    return 'Не установлена faster-whisper. Выполни: python -m pip install -r requirements.txt';
  }
  if (/charmap|UnicodeEncodeError/i.test(log)) {
    return 'Python выводит текст в неверной кодировке. Перезапусти приложение — теперь оно само включает UTF-8 (PYTHONUTF8=1).';
  }
  const lastMeaningful = [...transcriberLog].reverse().find((line) => !/^loading whisper|^whisper ready$/i.test(line));
  return lastMeaningful || fallback;
}

function spawnTranscriber(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-u', path.join(__dirname, 'transcriber.py')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Без этого Windows пишет stdout в cp1251/cp866 и кириллица падает с 'charmap' codec.
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONLEGACYWINDOWSSTDIO: '0'
      }
    });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

function attachTranscriber(child) {
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const output = readline.createInterface({ input: child.stdout });
  output.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      rememberTranscriberLog(trimmed);
      return;
    }
    // Ответ адресуется по id; если id нет — отдаём самому старому запросу.
    const key = transcriberPending.has(data.id) ? data.id : transcriberPending.keys().next().value;
    const request = transcriberPending.get(key);
    if (!request) return;
    transcriberPending.delete(key);
    clearTimeout(request.timeout);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(typeof data.text === 'string' ? data.text.trim() : '');
  });

  child.stderr.on('data', (chunk) => {
    rememberTranscriberLog(chunk);
    console.error(`Whisper: ${String(chunk).trim()}`);
  });

  const fail = (reason) => {
    transcriber = null;
    output.close();
    for (const [, request] of transcriberPending) {
      clearTimeout(request.timeout);
      request.reject(new Error(reason));
    }
    transcriberPending.clear();
  };

  child.on('exit', (code, signal) => fail(describeTranscriberFailure(`процесс Python завершился (code=${code}, signal=${signal}).`)));
  child.on('error', (error) => fail(error.message));
}

async function ensureTranscriber() {
  if (transcriber && !transcriber.killed && transcriber.exitCode === null) return transcriber;
  if (transcriberStarting) return transcriberStarting;

  transcriberStarting = (async () => {
    const candidates = [process.env.PYTHON_EXECUTABLE, 'python', 'python3', 'py'].filter(Boolean);
    let lastError = null;
    for (const command of candidates) {
      try {
        const child = await spawnTranscriber(command);
        console.log(`Whisper: запущен через "${command}"`);
        transcriberLog = [];
        attachTranscriber(child);
        transcriber = child;
        return child;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Python не найден (${lastError?.message || 'нет исполняемого файла'}). Запусти приложение из активной venv или задай переменную PYTHON_EXECUTABLE.`);
  })();

  try {
    return await transcriberStarting;
  } finally {
    transcriberStarting = null;
  }
}

async function transcribeLocally(bytes, mimeType) {
  const extension = (mimeType || 'audio/webm').includes('ogg') ? '.ogg' : '.webm';
  const tempDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'english-lesson-'));
  const audioPath = path.join(tempDirectory, `segment${extension}`);
  try {
    await fs.writeFile(audioPath, Buffer.from(bytes));
    const child = await ensureTranscriber();
    const id = ++transcriberRequestId;

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        transcriberPending.delete(id);
        reject(new Error('Python не ответил за 2 минуты. Возможно, скачивается модель Whisper — попробуй ещё раз.'));
      }, TRANSCRIBE_TIMEOUT_MS);
      transcriberPending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, path: audioPath })}\n`, (error) => {
        if (!error) return;
        transcriberPending.delete(id);
        clearTimeout(timeout);
        reject(error);
      });
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Python не найден. Запусти приложение из активной venv или задай PYTHON_EXECUTABLE.');
    }
    const details = (error.message || '').trim();
    if (details.includes('No module named') && details.includes('faster_whisper')) {
      throw new Error('Не установлена faster-whisper. Выполни: python -m pip install -r requirements.txt');
    }
    throw new Error(`Локальное распознавание не удалось: ${details}`);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

function getProviderErrorMessage(data, status) {
  if (typeof data?.error === 'string') return data.error;
  if (data?.error?.message) return String(data.error.message);
  if (data?.message) return String(data.message);
  return `HTTP ${status}`;
}

function normalizeApiKey(value) {
  let key = String(value || '').trim();
  const bearerMatch = key.match(/Bearer\s+([^\s'"]+)/i);
  if (bearerMatch) key = bearerMatch[1];
  return key
    .replace(/^Authorization\s*:\s*/i, '')
    .replace(/^INCEPTION_API_KEY\s*=\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

async function inceptionRequest(apiKey, body) {
  const token = normalizeApiKey(apiKey);
  if (!token) throw new Error('Добавьте Inception Labs API key в настройках.');

  console.log(`Inception Labs → ${body.model}`);
  const send = async (payload) => {
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }
    return { response, data };
  };

  let payload = body;
  let { response, data } = await send(payload);

  // Не каждый OpenAI-compatible провайдер принимает reasoning_effort/response_format — мягко деградируем.
  for (const field of ['reasoning_effort', 'response_format']) {
    if (response.ok || !payload[field]) continue;
    const message = getProviderErrorMessage(data, response.status);
    const mayBeUnsupportedOptionalField = response.status === 400
      || /reasoning|effort|response_format|json_object|unsupported|unknown|extra|invalid/i.test(message);
    if (!mayBeUnsupportedOptionalField) continue;
    const { [field]: _ignored, ...withoutOptionalField } = payload;
    payload = withoutOptionalField;
    ({ response, data } = await send(payload));
  }

  if (!response.ok) {
    const message = getProviderErrorMessage(data, response.status);
    console.log('Inception Labs error:', message);
    if (/missing authentication header/i.test(message)) {
      throw new Error('Inception Labs не получил заголовок Authorization. Проверьте, что в поле вставлен именно API key Inception Labs без лишнего текста; префикс Bearer можно не писать.');
    }
    if (/(model|модель)/i.test(message) && /not found|does not exist|not exist|unavailable|unsupported|invalid|недоступ|не найден/i.test(message)) {
      throw new Error(`Модель ${body.model} недоступна в Inception Labs: ${message}`);
    }
    if (/balance|credit|quota|billing/i.test(message)) {
      throw new Error(`Inception Labs отклонил запрос из-за баланса или квоты: ${message}`);
    }
    throw new Error(message || 'Ошибка запроса к Inception Labs.');
  }
  return data;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0b1020',
    title: 'English Lesson Copilot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    } catch (error) {
      console.error(error);
      callback({});
    }
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (transcriber) {
    try { transcriber.stdin.end(); } catch { /* уже закрыт */ }
    transcriber.kill();
    transcriber = null;
  }
});

ipcMain.handle('ai:transcribe', async (_event, payload) => {
  // Распознавание локальное — ключ здесь не нужен, он требуется только для перевода.
  const { bytes, mimeType } = payload;
  if (!bytes?.length) throw new Error('Пустой аудиофрагмент.');
  return transcribeLocally(bytes, mimeType);
});

ipcMain.handle('app:screenshot', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: 900 }
  });
  const thumbnail = sources[0]?.thumbnail;
  if (!thumbnail || thumbnail.isEmpty()) throw new Error('Не удалось сделать снимок экрана.');
  return thumbnail.toDataURL();
});

ipcMain.handle('ai:assist', async (_event, payload) => {
  const { apiKey, text, targetLanguage, replyStyle, context = [], screenshot } = payload;
  if (!apiKey) throw new Error('Добавьте Inception Labs API key в настройках.');

  const currentContent = [{
    type: 'text',
    text: screenshot
      ? `Use the attached screenshot as visual context for this spoken phrase. Connect the phrase to any visible text, exercise, slide, or question in the screenshot. Spoken phrase:\n${text}`
      : text
  }];
  if (screenshot) currentContent.push({ type: 'image_url', image_url: { url: screenshot } });

  const requestBody = {
    model: ASSIST_MODEL,
    temperature: 0.35,
    max_completion_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You help a student during a live English lesson. The teacher may speak English or Russian. Use every attached screenshot as active lesson context, not as a separate unrelated image. When a screenshot contains a task, question, slide, chat, or visible text, connect the teacher's spoken phrase to it before answering. Translate the teacher's phrase into ${targetLanguage}. Then suggest exactly 3 short, natural replies written only in English, in a ${replyStyle} style. Return only JSON: {"translation":"...","replies":["...","...","..."]}. Do not invent context.`
      },
      ...context,
      { role: 'user', content: currentContent }
    ]
  };
  if (ASSIST_REASONING_EFFORT && ASSIST_REASONING_EFFORT !== 'none') {
    requestBody.reasoning_effort = ASSIST_REASONING_EFFORT;
  }

  const data = await inceptionRequest(apiKey, requestBody);
  const raw = (data.choices?.[0]?.message?.content || '{}')
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      translation: String(parsed.translation || ''),
      replies: Array.isArray(parsed.replies) ? parsed.replies.slice(0, 3).map(String) : []
    };
  } catch {
    throw new Error('Модель вернула ответ в неверном формате.');
  }
});
