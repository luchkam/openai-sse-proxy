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
  process.stdout.write('📥 Вызван endpoint /search-tours\n');

  try {
    const toolCall = req.body?.tool_calls?.[0];
    if (!toolCall) {
      process.stdout.write('❌ Не найден tool_call в теле запроса\n');
      return res.status(400).json({ error: 'tool_call not found' });
    }

    const threadId = req.body.thread_id;
    const runId = req.body.run_id;

    const args = JSON.parse(toolCall.function.arguments);
    process.stdout.write(`📦 Аргументы функции: ${JSON.stringify(args, null, 2)}\n`);

    // 👉 Пример запроса к Tourvisor API (заглушка, заменим реальными данными)
    const tourvisorResponse = await axios.post('https://sse-proxy.onrender.com/test-search', args);

    // Берём первые 3 тура
    const tours = tourvisorResponse.data.tours?.slice(0, 3) ?? [];

    const resultText = tours.length
      ? tours.map((t, i) => `${i + 1}. ${t}`).join('\n')
      : '❌ Туры не найдены. Попробуйте изменить параметры поиска.';

    // 📨 Отправляем tool_output обратно в OpenAI
    await axios.post(
      `https://api.openai.com/v1/threads/${threadId}/runs/${runId}/submit_tool_outputs`,
      {
        tool_outputs: [
          {
            tool_call_id: toolCall.id,
            output: resultText,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    process.stdout.write('✅ Ответ ассистенту отправлен успешно\n');
    res.json({ status: 'ok' });
  } catch (err) {
    process.stdout.write(`❌ Ошибка при обработке функции: ${err.message}\n`);
    res.status(500).json({ error: 'Ошибка при обработке запроса' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  process.stdout.write(`✅ SSE Proxy Server listening on port ${PORT}\n`); // Логируем запуск сервера
});
