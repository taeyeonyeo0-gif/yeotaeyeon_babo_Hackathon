export function appendSupplementalCctv(data, csvText) {
  const facilities = data?.facilities;
  if (!Array.isArray(facilities)) throw new Error('시설 데이터 목록이 없습니다.');
  const lines = String(csvText).replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1);
  const existing = new Set(facilities
    .filter(item => item.type === 'cctv' && Array.isArray(item.p))
    .map(item => `${item.p[0].toFixed(7)},${item.p[1].toFixed(7)}`));
  let added = 0;
  for (const line of lines) {
    const row = line.split(',');
    const lat = Number(row[1]);
    const lon = Number(row[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const key = `${lon.toFixed(7)},${lat.toFixed(7)}`;
    if (existing.has(key)) continue;
    facilities.push({ id: `cheonho-cctv-${row[0]}`, type: 'cctv', p: [lon, lat], date: '천호동_CCTV.csv', supplemental: true });
    existing.add(key);
    added++;
  }
  return added;
}
