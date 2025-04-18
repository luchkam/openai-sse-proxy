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

  // Логируем параметры
  process.stdout.write('📤 Тестовый payload: ' + JSON.stringify(payload, null, 2) + '\n');
  process.stdout.write('🔧 Отправляем параметры в Tourvisor:\n' + JSON.stringify(searchParams, null, 2) + '\n');

  try {
    // 1. Получаем requestid
    const { data } = await axios.get('https://tourvisor.ru/xml/search.php', { params: searchParams });
    const requestid = data?.result?.requestid;

    process.stdout.write('📩 Ответ от Tourvisor (search.php):\n' + JSON.stringify(data, null, 2) + '\n');

    if (!requestid) {
      throw new Error('Не получен requestid');
    }

    // 2. Ожидаем результат
    for (let i = 1; i <= 6; i++) {
      const res = await axios.get('https://tourvisor.ru/xml/result.php', {
        params: {
          requestid,
          format: 'json',
          authlogin: searchParams.authlogin,
          authpass: searchParams.authpass
        }
      });

      const hotels = res.data?.result?.hotel || [];
      const status = res.data?.status?.state;

      process.stdout.write(`⏱️ Попытка ${i} — статус: ${status}, найдено отелей: ${hotels.length}\n`);

      if (status === 'finished' && hotels.length > 0) {
        process.stdout.write('✅ Успешно получены туры\n');
        return hotels.slice(0, 3); // топ-3 отеля
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    return { error: 'Не удалось получить результат поиска за 12 секунд' };
  } catch (error) {
    process.stdout.write('💥 Ошибка в searchToursTest:\n' + error.message + '\n');
    return { error: error.message };
  }
}

module.exports = { searchTours };
