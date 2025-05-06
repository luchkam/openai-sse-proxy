const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Авторизационные данные для Tourvisor
const TOURVISOR_LOGIN = 'info@meridiantt.com';
const TOURVISOR_PASSWORD = 'Mh4GdKPUtwZT';

// Функция для запроса данных из API Tourvisor (справочники)
const getTourvisorData = async (type, params = {}) => {
  const url = `http://tourvisor.ru/xml/list.php?format=json&type=${type}&authlogin=${TOURVISOR_LOGIN}&authpass=${TOURVISOR_PASSWORD}`;
  const response = await axios.get(url, { params });
  return response.data;
};

// Функция для поиска туров через API Tourvisor
const searchTours = async (departure, country, dateFrom, dateTo, nights, adults, children) => {
  const searchParams = {
    departure,
    country,
    datefrom: dateFrom,
    dateto: dateTo,
    nightsfrom: nights,
    nightsto: nights,
    adults,
    child: children.length,
    childage1: children[0] || null,
    childage2: children[1] || null,
    childage3: children[2] || null,
    format: 'json'
  };

  const searchUrl = `http://tourvisor.ru/xml/search.php?authlogin=${TOURVISOR_LOGIN}&authpass=${TOURVISOR_PASSWORD}`;
  
  try {
    const searchResponse = await axios.get(searchUrl, { params: searchParams });
    const requestId = searchResponse.data.requestid;

    // Получаем статус поиска
    let statusResponse = await axios.get(`http://tourvisor.ru/xml/result.php?authlogin=${TOURVISOR_LOGIN}&authpass=${TOURVISOR_PASSWORD}&requestid=${requestId}&type=status`);
    while (statusResponse.data.status.state === 'searching') {
      console.log('Поиск в процессе...');
      await new Promise(resolve => setTimeout(resolve, 2000)); // Задержка для получения статуса
      statusResponse = await axios.get(`http://tourvisor.ru/xml/result.php?authlogin=${TOURVISOR_LOGIN}&authpass=${TOURVISOR_PASSWORD}&requestid=${requestId}&type=status`);
    }

    // Получаем результаты поиска
    const resultsResponse = await axios.get(`http://tourvisor.ru/xml/result.php?authlogin=${TOURVISOR_LOGIN}&authpass=${TOURVISOR_PASSWORD}&requestid=${requestId}&type=result`);

    // Обрабатываем результаты (сортировка по цене и выбор 3 самых дешевых)
    const tours = resultsResponse.data.result[0].hotel[0].tours;
    const sortedTours = tours.sort((a, b) => a.price - b.price).slice(0, 3);

    // Формируем текстовый ответ с 3 самыми дешевыми турами
    let resultText = 'Вот 3 самых дешевых тура:\n';
    sortedTours.forEach(tour => {
      resultText += `- ${tour.hotelname} (${tour.flydate}): ${tour.price} руб.\n`;
    });

    return resultText;
  } catch (error) {
    console.error('Ошибка при поиске тура:', error);
    throw new Error('Не удалось найти туры.');
  }
};

// Функция для общения с Assistant OpenAI API
const sendToAssistant = async (message, threadId) => {
  const url = `https://api.openai.com/v1/assistants/${process.env.ASSISTANT_ID}/runs`; // Используем нужный endpoint для взаимодействия с ассистентом

  try {
    const response = await axios.post(
      url,
      {
        assistant_id: process.env.ASSISTANT_ID, // Идентификатор ассистента
        thread_id: threadId, // Используем thread_id для сохранения контекста
        messages: [
          { role: "user", content: message }, // Отправляем сообщение пользователя
        ],
        stream: true, // Включаем потоковый ответ
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // API ключ OpenAI
        },
      }
    );

    // Обрабатываем ответ от ассистента
    return response.data;
  } catch (error) {
    console.error("Ошибка при отправке сообщения в Assistant:", error);
    throw new Error("Не удалось получить ответ от ассистента.");
  }
};

// Новый endpoint для поиска туров
app.get('/search-tours', async (req, res) => {
  const { departure, country, dateFrom, dateTo, nights, adults, children } = req.query;

  if (!departure || !country || !dateFrom || !dateTo || !nights || !adults) {
    return res.status(400).json({ error: 'Не все параметры были переданы.' });
  }

  try {
    // Получаем текстовый результат поиска туров
    const resultText = await searchTours(departure, country, dateFrom, dateTo, nights, adults, children.split(','));

    // Отправляем запрос в Assistant с полученным текстом
    const assistantResponse = await sendToAssistant(resultText, req.session.threadId);

    // Ответ от ассистента
    res.json({ result: assistantResponse });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Простой endpoint для общения с ассистентом (другие запросы)
app.get('/ask', async (req, res) => {
  const { message, threadId } = req.query;

  if (!message || !threadId) {
    return res.status(400).json({ error: 'Не все параметры были переданы.' });
  }

  try {
    const assistantResponse = await sendToAssistant(message, threadId);
    res.json({ result: assistantResponse });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер слушает на порту ${PORT}`);
});
