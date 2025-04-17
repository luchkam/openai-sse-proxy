const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Настройка CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(cors());
app.use(express.json());

// Ключи API Tourvisor (лучше хранить в переменных окружения)
const TOURVISOR_AUTH = {
  authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
  authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
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
      }
    );
    res.json({ thread_id: response.data.id });
  } catch (err) {
    console.error('Ошибка при создании треда:', err.message);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

// 2. Функция для получения результатов поиска с пагинацией
async function getTourvisorResults(requestId) {
  const baseUrl = 'http://tourvisor.ru/xml/result.php';
  
  // Проверяем статус поиска (макс 10 секунд)
  const statusUrl = `${baseUrl}?${new URLSearchParams({
    ...TOURVISOR_AUTH,
    requestid: requestId,
    type: 'status',
    format: 'json'
  })}`;

  let attempts = 0;
  while (attempts < 5) {
    try {
      const statusRes = await axios.get(statusUrl);
      if (statusRes.data?.status?.state === 'finished') break;
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
    } catch (err) {
      console.error('Ошибка проверки статуса:', err.message);
      return null;
    }
  }

  // Получаем результаты постранично (макс 3 страницы)
  const results = [];
  for (let page = 1; page <= 3; page++) {
    try {
      const resultUrl = `${baseUrl}?${new URLSearchParams({
        ...TOURVISOR_AUTH,
        requestid: requestId,
        format: 'json',
        page: page,
        onpage: 10 // Лимит 10 отелей на страницу
      })}`;

      const resultRes = await axios.get(resultUrl);
      const hotels = resultRes.data?.result?.hotel;
      
      if (!hotels || !hotels.length) break;
      results.push(...hotels);
      
    } catch (err) {
      console.error(`Ошибка при получении страницы ${page}:`, err.message);
      break;
    }
  }

  return results;
}

// 3. Обработчик function call от ассистента
async function handleFunctionCall(threadId, funcCall) {
  if (funcCall.name !== 'search_tours') return null;

  try {
    const args = JSON.parse(funcCall.arguments);
    console.log('🔍 Параметры поиска:', args);

    // Запускаем поиск в Tourvisor
    const searchUrl = `http://tourvisor.ru/xml/search.php?${new URLSearchParams({
      ...TOURVISOR_AUTH,
      departure: args.departure,
      country: args.country,
      datefrom: args.datefrom,
      dateto: args.dateto,
      nightsfrom: args.nightsfrom || 7,
      nightsto: args.nightsto || 10,
      adults: args.adults || 2,
      child: args.child || 0,
      format: 'json'
    })}`;

    const searchRes = await axios.get(searchUrl);
    const requestId = searchRes.data?.result?.requestid;
    if (!requestId) return '❌ Не удалось запустить поиск. Попробуйте позже.';

    // Получаем результаты
    const hotels = await getTourvisorResults(requestId);
    if (!hotels?.length) return '😞 По вашему запросу туров не найдено.';

    // Формируем топ-3 самых дешевых тура
    const allTours = hotels.flatMap(h => 
      Array.isArray(h.tours?.tour) ? h.tours.tour : [h.tours?.tour].filter(Boolean)
    );

    const topTours = allTours
      .sort((a, b) => a.price - b.price)
      .slice(0, 3);

    // Красивый формат ответа
    return topTours.map((tour, i) => 
      `${i + 1}. 🏨 ${tour.hotelname || 'Отель не указан'}\n` +
      `   ✈️ ${tour.flydate}, ${tour.nights} ночей\n` +
      `   🍽 ${tour.mealrussian || 'Питание не указано'}\n` +
      `   💰 От ${tour.price?.toLocaleString() || '---'} KZT`
    ).join('\n\n');

  } catch (err) {
    console.error('❌ Ошибка в search_tours:', err.message);
    return '⚠️ Произошла ошибка при поиске туров. Пожалуйста, уточните параметры.';
  }
}

// 4. Основной эндпоинт для чата
app.get('/ask', async (req, res) => {
  const { message, thread_id } = req.query;
  
  if (!thread_id) {
    return res.status(400).json({ error: 'Отсутствует thread_id' });
  }

  // Настраиваем SSE-соединение
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let isFunctionCall = false;

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
        responseType: 'stream',
      }
    );

    // Обрабатываем поток данных от OpenAI
    run.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        
        try {
          if (jsonStr === '[DONE]') return;
          
          const data = JSON.parse(jsonStr);
          if (data.function_call) {
            isFunctionCall = true;
            // Обрабатываем function call асинхронно
            handleFunctionCall(thread_id, data.function_call)
              .then(result => {
                // Отправляем результат ассистенту
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
                  }
                );
              })
              .then(() => {
                // Запускаем новый run для продолжения диалога
                return axios.post(
                  `https://api.openai.com/v1/threads/${thread_id}/runs`,
                  {
                    assistant_id: process.env.ASSISTANT_ID,
                    stream: true,
                  },
                  {
                    headers: {
                      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                      'OpenAI-Beta': 'assistants=v2',
                    },
                    responseType: 'stream',
                  }
                );
              })
              .then(newRun => {
                newRun.data.on('data', (chunk) => {
                  const lines = chunk.toString().split('\n');
                  lines.forEach(line => {
                    if (line.startsWith('data: ')) {
                      sendEvent(JSON.parse(line.slice(6)));
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
      }
    });

    run.data.on('end', () => {
      if (!isFunctionCall) {
        sendEvent('[DONE]');
        res.end();
      }
    });

  } catch (err) {
    console.error('🔥 Ошибка в /ask:', err.message);
    sendEvent({ error: err.message });
    res.end();
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
