const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const readline = require('readline');
const path = require('path');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ASSIST_MODEL = process.env.ASSIST_MODEL || 'openai/gpt-6-sol';
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

async function openRouterRequest(apiKey, body) {
  console.log(`OpenRouter → ${body.model}`);
  const send = async (payload) => {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/sharipaxman/perevod',
        'X-Title': 'English Lesson Copilot'
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  let { response, data } = await send(body);

  // Не каждый провайдер принимает reasoning/response_format — мягко деградируем.
  if (!response.ok && body.reasoning) {
    const message = String(data.error?.message || '');
    if (/reasoning|effort/i.test(message) || response.status === 400) {
      const { reasoning, ...withoutReasoning } = body;
      ({ response, data } = await send(withoutReasoning));
    }
  }

  if (!response.ok) {
    const message = data.error?.message || `HTTP ${response.status}`;
    console.log('OpenRouter error:', message);
    if (/no endpoints|not exist|no allowed providers/i.test(message)) {
      throw new Error(`Модель ${body.model} недоступна для этого ключа: ${message}`);
    }
    if (/balance|credit/i.test(message)) {
      throw new Error(`OpenRouter отклонил запрос из-за баланса: ${message}`);
    }
    throw new Error(message || 'Ошибка запроса к OpenRouter.');
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
  if (!apiKey) throw new Error('Добавьте OpenRouter API key в настройках.');

  const currentContent = [{
    type: 'text',
    text: screenshot
      ? `Use the attached screenshot as visual context for this spoken phrase. Connect the phrase to any visible text, exercise, slide, or question in the screenshot. Spoken phrase:\n${text}`
      : text
  }];
  if (screenshot) currentContent.push({ type: 'image_url', image_url: { url: screenshot } });

  const data = await openRouterRequest(apiKey, {
    model: ASSIST_MODEL,
    temperature: 0.35,
    max_tokens: 400,
    reasoning: { effort: ASSIST_REASONING_EFFORT },
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You help a student during a live English lesson. The teacher may speak English or Russian. Use every attached screenshot as active lesson context, not as a separate unrelated image. When a screenshot contains a task, question, slide, chat, or visible text, connect the teacher's spoken phrase to it before answering. Translate the teacher's phrase into ${targetLanguage}. Then suggest exactly 3 short, natural replies written only in English, in a ${replyStyle} style. Return only JSON: {"translation":"...","replies":["...","...","..."]}. Do not invent context.`
      },
      ...context,
      { role: 'user', content: currentContent }
    ]
  });
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
