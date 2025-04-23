const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const searchTours = require('./searchToursTest'); // Импортируем функцию поиска туров
const app = express();

// CORS
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// Новый эндпоинт для обработки поиска туров
app.post('/search-tours', async (req, res) => {
  const { country, datefrom, dateto, adults, child, type, budget } = req.body;

  try {
    // Отправляем данные в Tourvisor API для поиска
    const searchData = {
      departure: 59, // Примерная информация для теста
      country: country,
      datefrom: datefrom,
      dateto: dateto,
      nightsfrom: 7,
      nightsto: 10,
      adults: adults,
      child: child,
    };

    const result = await searchTours(searchData); // Вызов функции поиска
    res.json(result); // Отправляем результат обратно в чат
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Порт по умолчанию
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
