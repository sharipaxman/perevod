const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const readline = require('readline');
const path = require('path');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ASSIST_MODEL = 'openrouter/free';
let transcriber = null;
let transcriberQueue = Promise.resolve();

async function openRouterRequest(apiKey, body) {
  console.log('Sending request to OpenRouter, body:', JSON.stringify(body).substring(0, 200));
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'English Lesson Copilot'
    },
    body: JSON.stringify(body)
  });
  console.log('Response status:', response.status);
  const data = await response.json();
  if (!response.ok) {
    console.log('Error response:', data);
    const message = data.error?.message || '';
    if (message.toLowerCase().includes('balance') && message.toLowerCase().includes('audio')) {
      throw new Error('OpenRouter требует минимум $0.50 на балансе для распознавания аудио. Пополните баланс в панели OpenRouter или используйте локальное распознавание.');
    }
    throw new Error(message || 'Ошибка запроса к OpenRouter.');
  }
  return data;
}

async function transcribeLocally(bytes, mimeType) {
  console.log('Transcribing locally with bytes:', bytes.length);
  const extension = (mimeType || 'audio/webm').includes('ogg') ? '.ogg' : '.webm';
  const tempDirectory = await fs.mkdtemp(path.join(app.getPath('temp'), 'english-lesson-'));
  const audioPath = path.join(tempDirectory, `segment${extension}`);
  try {
    await fs.writeFile(audioPath, Buffer.from(bytes));
    if (!transcriber) {
      const python = process.env.PYTHON_EXECUTABLE || 'python';
      transcriber = spawn(python, ['-u', path.join(__dirname, 'transcriber.py')], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      transcriber.stderr.on('data', (chunk) => console.error(`Whisper: ${chunk}`));
      transcriber.on('exit', () => { transcriber = null; });
    }

    const result = await new Promise((resolve, reject) => {
      transcriberQueue = transcriberQueue.then(() => new Promise((queueResolve, queueReject) => {
        const output = readline.createInterface({ input: transcriber.stdout });
        const onLine = (line) => {
          output.close();
          try {
            const data = JSON.parse(line);
            if (data.error) queueReject(new Error(data.error));
            else queueResolve(data.text?.trim() || '');
          } catch (error) {
            queueReject(error);
          }
        };
        output.once('line', onLine);
        transcriber.once('error', queueReject);
        transcriber.stdin.write(`${audioPath}\n`);
      })).then(resolve, reject);
    });
    return result;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Python не найден. Запусти приложение из активной venv или задай PYTHON_EXECUTABLE.');
    }
    const details = error.stderr?.trim() || error.message;
    if (details.includes('No module named') && details.includes('faster_whisper')) {
      throw new Error('Не установлена faster-whisper. Выполни: pip install -r requirements.txt');
    }
    throw new Error(`Локальное распознавание не удалось: ${details}`);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
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

ipcMain.handle('ai:transcribe', async (_event, payload) => {
  const { apiKey, bytes, mimeType } = payload;
  if (!apiKey) throw new Error('Добавьте OpenRouter API key в настройках.');
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
