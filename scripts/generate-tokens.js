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
    ee.data.authenticateViaPrivateKey(
      saKey,
      () => {
        ee.initialize(
          null,
          null,
          () => resolve(),
          (err) => reject(new Error('Init failed: ' + err)),
          null,
          saKey.project_id
        );
      },
      (err) => reject(new Error('Auth failed: ' + err))
    );
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

function encodeElevationToTerrarium(elevImg) {
  const q = elevImg
    .add(32768.0)
    .multiply(256.0)
    .round()
    .clamp(0, 16777215)
    .toInt32();

  const r = q.rightShift(16).bitwiseAnd(255).toUint8();
  const g = q.rightShift(8).bitwiseAnd(255).toUint8();
  const b = q.bitwiseAnd(255).toUint8();

  return ee.Image.cat([r, g, b]).rename(['R', 'G', 'B']);
}

async function run() {
  console.log('Подключение к Google Earth Engine...');
  await authenticate();
  console.log('Успешная авторизация.');

  // 1. Высота крон (Meta Canopy Height)
  const colHeight = ee.ImageCollection('projects/meta-forest-monitoring-okw37/assets/CanopyHeight').mosaic();
  const heightUrl = await getMapUrl(colHeight, {
    min: 0,
    max: 25,
    palette: ['440154', '482878', '3e4989', '31688e', '26828e', '1f9e89', '35b779', '6ece58', 'b5de2b', 'fde725']
  });

  // 2. Маска леса (деревья >= 1м)
  const maskImg = colHeight.gte(1).selfMask();
  const maskUrl = await getMapUrl(maskImg, { min: 0, max: 1, palette: ['00ff00'] });

  // 3. Породы леса (GLC-FCS30D)
  const classValues = [
    10, 11, 12, 20, 51, 52, 61, 62, 71, 72, 81, 82, 91, 92,
    120, 121, 122, 130, 140, 150, 152, 153, 181, 182, 183, 184, 185, 186, 187,
    190, 200, 201, 202, 210, 220, 0
  ];
  const newValues = ee.List.sequence(1, 36);
  const palette = [
    'ffff64', 'ffff64', 'ffff00', 'aaf0f0', '4c7300', '006400',
    'a8c800', '00a000', '005000', '003c00', '286400', '285000',
    'a0b432', '788200', '966400', '964b00', '966400', 'ffb432',
    'ffdcd2', 'ffebaf', 'ffd278', 'ffebaf', '00a884', '73ffdf',
    '9ebb3b', '828282', 'f57ab6', '66cdab', '444f89', 'c31400',
    'fff5d7', 'dcdcdc', 'fff5d7', '0046c8', 'ffffff', 'ffffff'
  ];

  const speciesRaw = ee.ImageCollection('projects/sat-io/open-datasets/GLC-FCS30D/annual').mosaic().select('b21');
  const speciesImg = speciesRaw.remap(classValues, newValues);
  const speciesUrl = await getMapUrl(speciesImg, { min: 1, max: 36, palette });

  // 4. Маска водоёмов (ESA WorldCover 10m 2021, класс 80 = Permanent water bodies)
  const wcImg = ee.ImageCollection('ESA/WorldCover/v200').mosaic().select('Map');
  const waterImg = wcImg.eq(80).selfMask();
  const waterUrl = await getMapUrl(waterImg, { min: 0, max: 1, palette: ['0064c8'] });

  // 5. FABDEM (30 м без лесов и зданий, покрытие 60°S–80°N)
  const fabdemRect = ee.Geometry.Rectangle([-180, -60, 180, 80], null, false);
  const fabdemElev = ee.ImageCollection('projects/sat-io/open-datasets/FABDEM')
    .select(0)
    .map((i) => i.resample('bilinear'))
    .mosaic()
    .unmask(0)
    .clip(fabdemRect);
  const fabdemUrl = await getMapUrl(
    encodeElevationToTerrarium(fabdemElev),
    { bands: ['R', 'G', 'B'], min: 0, max: 255, format: 'png' }
  );

  // 6. Copernicus GLO-30 (30 м глобальный DSM)
  const copElev = ee.ImageCollection('COPERNICUS/DEM/GLO30_2024_1')
    .select('DEM')
    .map((i) => i.resample('bilinear'))
    .mosaic()
    .unmask(0);
  const copernicusUrl = await getMapUrl(
    encodeElevationToTerrarium(copElev),
    { bands: ['R', 'G', 'B'], min: 0, max: 255, format: 'png' }
  );

  const result = {
    updatedAt: new Date().toISOString(),
    expiresAt: Date.now() + (24 * 3600 * 1000),
    templates: {
      height: heightUrl,
      mask: maskUrl,
      species: speciesUrl,
      water: waterUrl,
      fabdem: fabdemUrl,
      copernicus: copernicusUrl
    },
    v2: {
      directMirrors: [
        'https://data.source.coop/tge-labs/meta-chm-v2/{path}',
        'https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/{path}'
      ]
    }
  };

  const outputPath = path.join(__dirname, '..', 'gee-tokens.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log('Файл gee-tokens.json успешно сохранён!');
}

run().catch((err) => {
  console.error('Ошибка выполнения:', err);
  process.exit(1);
});
