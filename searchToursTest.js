// searchToursTest.js
const axios = require('axios');

async function searchTours(payload) {
  const { departure, country, datefrom, dateto, nightsfrom, nightsto, adults, child } = payload;

  const searchParams = {
    format: 'json',
    departure,
    country,
    datefrom,
    dateto,
    nightsfrom,
    nightsto,
    adults,
    child: child || 0,
    authlogin: 'info@meridiantt.com',
    authpass: 'Mh4GdKPUtwZT'
  };

  console.log('📤 Тестовый payload:', payload);
  console.log('🔧 Отправляем параметры в Tourvisor:', searchParams);

  try {
    // Получение requestid
    const { data: searchResponse } = await axios.get('https://tourvisor.ru/xml/search.php', { params: searchParams });
    console.log('📩 Ответ от Tourvisor (search.php):', searchResponse);

    const requestid = searchResponse?.result?.requestid;
    if (!requestid) {
      console.error('❌ RequestID не получен');
      return { error: 'Не получен requestid' };
    }

    for (let i = 1; i <= 6; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const resultParams = {
        requestid,
        format: 'json',
        authlogin: searchParams.authlogin,
        authpass: searchParams.authpass
      };
      const { data: resultResponse } = await axios.get('https://tourvisor.ru/xml/result.php', { params: resultParams });
      const status = resultResponse?.status?.state;
      const hotels = resultResponse?.result?.hotel || [];

      console.log(`⏱️ Попытка ${i} — статус: ${status}, найдено отелей: ${hotels.length}`);

      if (status === 'finished' && hotels.length > 0) {
        return hotels.slice(0, 3);
      }
    }

    return { error: 'Не удалось получить результат поиска за 12 секунд' };
  } catch (error) {
    console.error('💥 Ошибка в searchToursTest:', error.message);
    return { error: error.message };
  }
}

module.exports = { searchTours };
