const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Увеличиваем лимиты для обработки больших JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Настройка CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Конфигурация Tourvisor
const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
    authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
  },
  timeout: 20000,
  retries: 3
};

const activeRequests = new Set();

app.get('/new-thread', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
        timeout: 5000
      }
    );
    res.json({ thread_id: response.data.id });
  } catch (err) {
    console.error('Ошибка при создании треда:', err.message);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

async function fetchTourvisorData(url, attempt = 1) {
  try {
    const response = await axios.get(url, {
      timeout: TOURVISOR_CONFIG.timeout,
      responseType: 'json'
    });

    if (!response.data) throw new Error('Пустой ответ от Tourvisor');
    return response.data;
  } catch (err) {
    if (attempt >= TOURVISOR_CONFIG.retries) {
      console.error(`Tourvisor API ошибка после ${attempt} попыток:`, err.message);
      throw err;
    }
    await new Promise(r => setTimeout(r, 2000 * attempt));
    return fetchTourvisorData(url, attempt + 1);
  }
}

async function searchTours(params) {
  try {
    const formatDate = (dateStr) => {
      const [year, month, day] = dateStr.split('-');
      return `${day}.${month}.${year}`;
    };

    const searchUrl = `http://tourvisor.ru/xml/search.php?${new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      departure: params.departure,
      country: params.country,
      datefrom: formatDate(params.datefrom),
      dateto: formatDate(params.dateto),
      nightsfrom: params.nightsfrom || 7,
      nightsto: params.nightsto || 10,
      adults: params.adults || 2,
      child: params.child || 0,
      format: 'json'
    })}`;

    console.log('🔍 Запрос к Tourvisor:', searchUrl);
    const searchData = await fetchTourvisorData(searchUrl);
    const requestId = searchData?.result?.requestid;
    if (!requestId) throw new Error('Не удалось получить requestId');

    const resultUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      requestid: requestId,
      format: 'json',
      onpage: 5
    })}`;

    const resultData = await fetchTourvisorData(resultUrl);
    return resultData?.result?.hotel || [];
  } catch (err) {
    console.error('Ошибка поиска туров:', err.message);
    throw err;
  }
}

async function handleFunctionCall(threadId, funcCall) {
  if (funcCall.name !== 'search_tours') return null;

  try {
    const args = JSON.parse(funcCall.arguments);
    console.log('🔍 Параметры поиска:', args);

    if (!args.departure || !args.country || !args.datefrom || !args.dateto) {
      return '⚠️ Пожалуйста, укажите все необходимые параметры для поиска.';
    }

    const hotels = await searchTours(args);
    if (!hotels.length) return '😞 По вашему запросу туров не найдено.';

    const allTours = hotels.flatMap(h => 
      Array.isArray(h.tours?.tour) ? h.tours.tour : [h.tours?.tour].filter(Boolean)
    );

    const topTours = allTours
      .filter(t => t?.price)
      .sort((a, b) => a.price - b.price)
      .slice(0, 3);

    if (!topTours.length) return '😞 Подходящие туры не найдены.';

    return topTours.map((t, i) => 
      `${i + 1}. 🏨 ${t.hotelname || 'Отель не указан'}\n` +
      `   ✈️ Вылет: ${t.flydate}, ${t.nights} ночей\n` +
      `   🍽 Питание: ${t.mealrussian || 'не указано'}\n` +
      `   💰 Цена: ${t.price?.toLocaleString() || '---'} KZT`
    ).join('\n\n');

  } catch (err) {
    console.error('❌ Ошибка в search_tours:', err.message);
    return '⚠️ Произошла ошибка при поиска туров. Пожалуйста, попробуйте позже.';
  }
}

app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;

  if (!thread_id) {
    return res.status(400).json({ error: 'Отсутствует thread_id' });
  }

  if (activeRequests.has(thread_id)) {
    return res.status(429).json({ error: 'Запрос уже обрабатывается' });
  }
  activeRequests.add(thread_id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error('Ошибка отправки SSE:', err);
    }
  };

  try {
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        assistant_id: process.env.ASSISTANT_ID,
        stream: true,
        additional_messages: [{ role: 'user', content: message }],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
        timeout: 30000,
        responseType: 'stream',
      }
    );

    let isFunctionCall = false;

    run.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));

      lines.forEach(line => {
        try {
          const jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') return;

          const data = JSON.parse(jsonStr);

          if (data.function_call) {
            isFunctionCall = true;
            handleFunctionCall(thread_id, data.function_call)
              .then(result => {
                return axios.post(
                  `https://api.openai.com/v1/threads/${thread_id}/messages`,
                  {
                    role: 'function',
                    name: data.function_call.name,
                    content: result || 'Нет данных',
                  },
                  {
                    headers: {
                      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                      'OpenAI-Beta': 'assistants=v2',
                    },
                    timeout: 10000
                  }
                );
              })
              .then(() => {
                return axios.post(
                  `https://api.openai.com/v1/threads/${thread_id}/runs`,
                  {
                    assistant_id: process.env.ASSISTANT_ID,
                  },
                  {
                    headers: {
                      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                      'OpenAI-Beta': 'assistants=v2',
                    },
                    timeout: 30000
                  }
                );
              })
              .then(newRun => {
                newRun.data.on('data', (chunk) => {
                  const lines = chunk.toString().split('\n');
                  lines.forEach(line => {
                    if (line.startsWith('data: ')) {
                      const data = JSON.parse(line.slice(6));
                      if (data.delta?.content) {
                        sendEvent(data);
                      }
                    }
                  });
                });
              })
              .catch(err => {
                console.error('Ошибка обработки function call:', err);
                sendEvent({ error: 'Ошибка поиска туров' });
              });
          } else if (!isFunctionCall && data.delta?.content) {
            sendEvent(data);
          }
        } catch (err) {
          console.warn('Ошибка парсинга JSON:', err.message);
        }
      });
    });

    run.data.on('end', () => {
      if (!isFunctionCall) {
        sendEvent('[DONE]');
        activeRequests.delete(thread_id);
        res.end();
      }
    });

    run.data.on('error', (err) => {
      console.error('Ошибка потока OpenAI:', err);
      sendEvent({ error: 'Ошибка соединения' });
      activeRequests.delete(thread_id);
      res.end();
    });

  } catch (err) {
    console.error('🔥 Ошибка в /ask:', err.message);
    sendEvent({ error: err.message });
    activeRequests.delete(thread_id);
    res.end();
  }
});

// ✅ Добавлено: запуск сервера с правильным портом
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
