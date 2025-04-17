const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Увеличиваем лимит размера JSON
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
  timeout: 15000, // 15 секунд на запрос
  retries: 3      // 3 попытки
};

// 1. Эндпоинт для создания нового треда
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

// 2. Улучшенная функция для работы с Tourvisor API
async function fetchTourvisorData(url, attempt = 1) {
  try {
    const response = await axios.get(url, {
      timeout: TOURVISOR_CONFIG.timeout,
      responseType: 'json'
    });
    
    if (!response.data) {
      throw new Error('Пустой ответ от Tourvisor');
    }
    
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

// 3. Поиск туров с улучшенной обработкой
async function searchTours(params) {
  try {
    // 1. Запуск поиска
    const searchUrl = `http://tourvisor.ru/xml/search.php?${new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      ...params,
      format: 'json'
    })}`;

    const searchData = await fetchTourvisorData(searchUrl);
    const requestId = searchData?.result?.requestid;
    if (!requestId) throw new Error('Не удалось получить requestId');

    // 2. Получение результатов
    const resultUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      requestid: requestId,
      format: 'json',
      onpage: 10 // Ограничиваем количество результатов
    })}`;

    const resultData = await fetchTourvisorData(resultUrl);
    return resultData?.result?.hotel || [];
  } catch (err) {
    console.error('Ошибка поиска туров:', err.message);
    throw err;
  }
}

// 4. Обработчик function call
async function handleFunctionCall(threadId, funcCall) {
  if (funcCall.name !== 'search_tours') return null;

  try {
    const args = JSON.parse(funcCall.arguments);
    console.log('🔍 Параметры поиска:', args);

    // Преобразуем параметры для Tourvisor
    const tourParams = {
      departure: args.departure,
      country: args.country,
      datefrom: args.datefrom.replace(/-/g, '.'),
      dateto: args.dateto.replace(/-/g, '.'),
      nightsfrom: args.nightsfrom || 7,
      nightsto: args.nightsto || 10,
      adults: args.adults || 2,
      child: args.child || 0
    };

    const hotels = await searchTours(tourParams);
    if (!hotels.length) return '😞 По вашему запросу туров не найдено.';

    // Формируем топ-3 самых дешевых тура
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
    return '⚠️ Произошла ошибка при поиске туров. Пожалуйста, попробуйте позже.';
  }
}

// 5. Основной эндпоинт для чата
app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  
  if (!thread_id) {
    return res.status(400).json({ error: 'Отсутствует thread_id' });
  }

  // Настраиваем SSE-соединение
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
    // Запускаем run в OpenAI
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

    // Обрабатываем поток данных от OpenAI
    run.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
      
      lines.forEach(line => {
        try {
          const jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') return;

          const data = JSON.parse(jsonStr);
          
          if (data.function_call) {
            // Обрабатываем function call асинхронно
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
                // Продолжаем диалог
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
              .catch(err => {
                console.error('Ошибка обработки function call:', err);
                sendEvent({ error: 'Ошибка поиска туров' });
              });
          } else if (data.delta?.content) {
            sendEvent(data);
          }
        } catch (err) {
          console.warn('Ошибка парсинга JSON:', err.message);
        }
      });
    });

    run.data.on('end', () => {
      sendEvent('[DONE]');
      res.end();
    });

    run.data.on('error', (err) => {
      console.error('Ошибка потока OpenAI:', err);
      sendEvent({ error: 'Ошибка соединения' });
      res.end();
    });

  } catch (err) {
    console.error('🔥 Ошибка в /ask:', err.message);
    sendEvent({ error: err.message });
    res.end();
  }
});

// Запуск сервера
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
