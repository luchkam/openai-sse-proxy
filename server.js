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

app.post('/search-tours', async (req, res) => {
  process.stdout.write('📥 Получен вызов функции search_tours от OpenAI Assistant\n');

  try {
    const toolCall = req.body?.tool_calls?.[0];
    if (!toolCall) {
      process.stdout.write('❌ Не найден tool_call в теле запроса\n');
      return res.status(400).json({ error: 'tool_call not found' });
    }

    const args = JSON.parse(toolCall.function.arguments);
    const {
      departure, country, datefrom, dateto,
      nightsfrom, nightsto, adults, child,
      childage1, childage2
    } = args;

    process.stdout.write(`🔍 Параметры поиска:\n${JSON.stringify(args, null, 2)}\n`);

    // Пока просто фиктивный ответ
    const fakeResult = `
Найдено 3 тура:
1. Тур в ${country}, отель Example Resort ★★★★ – 320 000 ₸
2. Тур в ${country}, отель Beach Paradise ★★★ – 290 000 ₸
3. Тур в ${country}, отель Family Club ★★★★★ – 350 000 ₸
    `;

    // Возвращаем ответ в OpenAI Assistant
    res.json({
      tool_outputs: [
        {
          tool_call_id: toolCall.id,
          output: fakeResult
        }
      ]
    });

    process.stdout.write('✅ Ответ отправлен в ассистент\n');
  } catch (err) {
    process.stdout.write(`❌ Ошибка в /search-tours: ${err.message}\n`);
    res.status(500).json({ error: 'Ошибка на сервере' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
