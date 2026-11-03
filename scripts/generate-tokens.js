const ee = require('@google/earthengine');
const fs = require('fs');
const path = require('path');

if (!process.env.GEE_SERVICE_ACCOUNT_KEY) {
  console.error('Ошибка: Переменная GEE_SERVICE_ACCOUNT_KEY не найдена!');
  process.exit(1);
}

const saKey = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY);

function authenticate() {
  return new Promise((resolve, reject) => {
    ee.data.authenticateViaPrivateKey(saKey, () => {
      ee.initialize(null, null, () => resolve(), (err) => reject(new Error('Init failed: ' + err)), null, saKey.project_id);
    }, (err) => reject(new Error('Auth failed: ' + err)));
  });
}

function getMapUrl(img, vis) {
  return new Promise((resolve, reject) => {
    img.getMapId(vis, (m, err) => {
      if (err) return reject(err);
      const url = m.urlFormat || `https://earthengine.googleapis.com/v1/${m.mapid}/tiles/{z}/{x}/{y}`;
      resolve(url);
    });
  });
}

async function run() {
  console.log('Подключение к Google Earth Engine...');
  await authenticate();
  console.log('Успешная авторизация.');

  // 1. Высота крон (Meta Canopy Height)
  const colHeight = ee.ImageCollection('projects/meta-forest-monitoring-okw37/assets/CanopyHeight').mosaic();
  const heightUrl = await getMapUrl(colHeight, {
    min: 0, max: 25,
    palette: ['440154', '482878', '3e4989', '31688e', '26828e', '1f9e89', '35b779', '6ece58', 'b5de2b', 'fde725']
  });

  // 2. Маска леса (деревья >= 1м)
  const maskImg = colHeight.gte(1).selfMask();
  const maskUrl = await getMapUrl(maskImg, { min: 0, max: 1, palette: ['00ff00'] });

  // 3. Породы леса (GLC-FCS30D)
  const classValues = [10, 11, 12, 20, 51, 52, 61, 62, 71, 72, 81, 82, 91, 92, 120, 121, 122, 130, 140, 150, 152, 153, 181, 182, 183, 184, 185, 186, 187, 190, 200, 201, 202, 210, 220, 0];
  const newValues = ee.List.sequence(1, 36);
  const palette = ['ffff64', 'ffff64', 'ffff00', 'aaf0f0', '4c7300', '006400', 'a8c800', '00a000', '005000', '003c00', '286400', '285000', 'a0b432', '788200', '966400', '964b00', '966400', 'ffb432', 'ffdcd2', 'ffebaf', 'ffd278', 'ffebaf', '00a884', '73ffdf', '9ebb3b', '828282', 'f57ab6', '66cdab', '444f89', 'c31400', 'fff5d7', 'dcdcdc', 'fff5d7', '0046c8', 'ffffff', 'ffffff'];
  
  const speciesRaw = ee.ImageCollection('projects/sat-io/open-datasets/GLC-FCS30D/annual').mosaic().select('b21');
  const speciesImg = speciesRaw.remap(classValues, newValues);
  const speciesUrl = await getMapUrl(speciesImg, { min: 1, max: 36, palette });

  const result = {
    updatedAt: new Date().toISOString(),
    expiresAt: Date.now() + (24 * 3600 * 1000),
    templates: {
      height: heightUrl,
      mask: maskUrl,
      species: speciesUrl
    }
  };

  const outputPath = path.join(__dirname, '..', 'gee-tokens.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log('Файл gee-tokens.json успешно сохранён!');
}

run().catch(err => {
  console.error('Ошибка выполнения:', err);
  process.exit(1);
});
