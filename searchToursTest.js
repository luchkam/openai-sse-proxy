const axios = require('axios');

// Конфигурация Tourvisor (ваши данные)
const TOURVISOR_AUTH = {
  authlogin: 'info@meridiantt.com',
  authpass: 'Mh4GdKPUtwZT',
  format: 'json'
};

// Логирование для Render
function log(message) {
  const timestamp = new Date().toISOString();
  process.stdout.write(`[${timestamp}] ${message}\n`);
}

// Запуск поиска
async function startSearch(params) {
  try {
    log(`Запуск поиска с параметрами: ${JSON.stringify(params)}`);
    const response = await axios.get('https://tourvisor.ru/xml/search.php', {
      params: { ...params, ...TOURVISOR_AUTH }
    });
    log(`Поиск запущен, requestid: ${response.data.result.requestid}`);
    return response.data.result.requestid;
  } catch (error) {
    log(`Ошибка при запуске поиска: ${error.message}`);
    throw error;
  }
}

// Проверка статуса
async function checkStatus(requestid) {
  try {
    log(`Проверка статуса для requestid: ${requestid}`);
    const response = await axios.get('https://tourvisor.ru/xml/result.php', {
      params: { ...TOURVISOR_AUTH, requestid, type: 'status' }
    });
    log(`Статус поиска: ${JSON.stringify(response.data.status)}`);
    return response.data.status;
  } catch (error) {
    log(`Ошибка при проверке статуса: ${error.message}`);
    throw error;
  }
}

// Получение топ-3 туров
async function getTopTours(requestid, limit = 3) {
  try {
    log(`Получение результатов для requestid: ${requestid}`);
    const response = await axios.get('https://tourvisor.ru/xml/result.php', {
      params: { ...TOURVISOR_AUTH, requestid, type: 'result' }
    });
    
    const allTours = response.data.result.hotel.flatMap(h => 
      h.tours.tour.map(t => ({
        hotel: h.hotelname,
        stars: h.hotelstars,
        price: t.price,
        date: t.flydate,
        nights: t.nights,
        link: `https://tourvisor.ru/tour/${t.tourid}`
      }))
    ).sort((a, b) => a.price - b.price);

    const topTours = allTours.slice(0, limit);
    log(`Найдено туров: ${allTours.length}, топ-${limit}: ${JSON.stringify(topTours)}`);
    return topTours;
  } catch (error) {
    log(`Ошибка при получении результатов: ${error.message}`);
    throw error;
  }
}

module.exports = { startSearch, checkStatus, getTopTours, log };
