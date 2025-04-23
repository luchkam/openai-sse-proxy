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

  try {
    process.stdout.write('\n📤 Тестовый payload: ' + JSON.stringify(payload) + '\n');
    process.stdout.write('🔧 Отправляем параметры в Tourvisor:\n' + JSON.stringify(searchParams, null, 2) + '\n');

    // 1. Получаем requestid
    const { data: searchData } = await axios.get('https://tourvisor.ru/xml/search.php', { params: searchParams });
    process.stdout.write('📩 Ответ от Tourvisor (search.php):\n' + JSON.stringify(searchData, null, 2) + '\n');

    const requestid = searchData?.result?.requestid;
    if (!requestid) throw new Error('Не получен requestid');

    // 2. Ожидаем результат
    for (let i = 1; i <= 6; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const { data: resultData } = await axios.get('https://tourvisor.ru/xml/result.php', {
        params: {
          requestid,
          format: 'json',
          authlogin: searchParams.authlogin,
          authpass: searchParams.authpass
        }
      });

      const status = resultData?.status?.state;
      const hotelCount = resultData?.result?.hotel?.length || 0;

      process.stdout.write(`⏱️ Попытка ${i} — статус: ${status}, найдено отелей: ${hotelCount}\n`);

      if (status === 'finished' && hotelCount > 0) {
        return resultData.result.hotel.slice(0, 3); // топ-3 отеля
      }
    }

    return { error: 'Не удалось получить результат поиска за 12 секунд' };
  } catch (error) {
    process.stdout.write('💥 Ошибка в searchToursTest: ' + error.message + '\n');
    return { error: error.message };
  }
}

module.exports = { searchTours };
