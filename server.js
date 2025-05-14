const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Новый endpoint для создания потока
app.get('/new-thread', async (req, res) => {
  process.stdout.write('Создание нового потока...\n'); // Логируем начало
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );
    process.stdout.write(`Новый thread_id создан: ${response.data.id}\n`); // Логируем успешный ответ
    res.json({ thread_id: response.data.id });
  } catch (err) {
    process.stdout.write(`Ошибка при создании thread_id: ${err.message}\n`); // Логируем ошибку
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// SSE endpoint для генерации и потоковой передачи ответа
app.get('/ask', async (req, res) => {
  const userMessage = req.query.message;
  const threadId = req.query.thread_id;

  if (!threadId) {
    process.stdout.write('Ошибка: отсутствует thread_id\n'); // Логируем отсутствие thread_id
    res.status(400).json({ error: 'thread_id отсутствует' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  process.stdout.write(`Запрос к OpenAI с thread_id: ${threadId}, сообщение: ${userMessage}\n`); // Логируем начало запроса

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
        additional_messages: [
          {
            role: 'user',
            content: userMessage,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
        responseType: 'stream',
      }
    );

    run.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr !== '[DONE]') {
            res.write(`data: ${jsonStr}\n\n`);
            process.stdout.write(`Отправлено: ${jsonStr}\n`); // Логируем отправку данных
          }
        }
      }
    });

    run.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
      process.stdout.write('Поток завершен\n'); // Логируем завершение потока
    });

  } catch (error) {
    process.stdout.write(`Ошибка в /ask: ${error.message}\n`); // Логируем ошибку
    console.error('Ошибка в /ask:', error.message);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

app.get('/search-tours', async (req, res) => {
  process.stdout.write('📥 Вызван GET /search-tours\n');
  console.log('👉 req.query.args:', req.query.args);

  try {
    const toolCallId = req.query.tool_call_id;
    const threadId = req.query.thread_id;
    const runId = req.query.run_id;
    const argsRaw = req.query.args;

    if (!toolCallId || !threadId || !runId || !argsRaw) {
      process.stdout.write('❌ Отсутствуют обязательные параметры\n');
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const args = JSON.parse(decodeURIComponent(argsRaw));
    process.stdout.write(`📦 Аргументы: ${JSON.stringify(args, null, 2)}\n`);

    // 🧪 Заглушка: просто фиктивные туры
    const tours = [
      "Тур в Турцию, отель Example Resort ★★★★ – 320 000 ₸",
      "Тур в Турцию, отель Beach Paradise ★★★ – 290 000 ₸",
      "Тур в Турцию, отель Family Club ★★★★★ – 350 000 ₸"
    ];

    const resultText = tours.map((t, i) => `${i + 1}. ${t}`).join('\n');

    // 📤 Отправка ответа в OpenAI
    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs/${runId}/submit_tool_outputs`,
      {
        tool_outputs: [
          {
            tool_call_id: toolCallId,
            output: resultText,
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        }
      }
    );

    process.stdout.write('✅ Ответ отправлен ассистенту\n');

    // ⏳ Дождёмся нового сообщения ассистента (после submit)
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    await delay(1500); // небольшая пауза, чтобы ассистент успел сгенерировать сообщение

    const messagesResp = await axios.get(
      `https://api.openai.com/v1/threads/${threadId}/messages`,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        }
      }
    );

    const messages = messagesResp.data.data;
    const lastMessage = messages.find(m => m.role === 'assistant' && m.content.length > 0);
    const finalText = lastMessage?.content[0]?.text?.value || 'Ответ ассистента не получен';

    process.stdout.write(`📩 Ответ ассистента: ${finalText}\n`);
    res.json({ message: finalText });

  } catch (err) {
    process.stdout.write(`❌ Ошибка: ${err.message}\n`);
    res.status(500).json({ error: 'Ошибка при обработке запроса' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
