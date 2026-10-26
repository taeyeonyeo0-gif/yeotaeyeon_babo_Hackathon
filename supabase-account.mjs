const reportTypes = new Set(['streetlight', 'sidewalk', 'crossing', 'cctv', 'other']);

function requireUser(userId) {
  if (typeof userId !== 'string' || !userId) throw Error('로그인 후 이용해 주세요.');
}

async function requireAuthenticatedOwner(client, userId) {
  requireUser(userId);
  const { data, error } = await client.auth.getUser();
  const errorText = (error?.message || '').toLowerCase();
  if (error && (error.status === 401 || error.statusCode === 401 || error.name === 'AuthSessionMissingError' || errorText.includes('session missing') || errorText.includes('not authenticated'))) {
    const missing = Error('로그인 세션이 없거나 만료됐습니다. 다시 로그인해 주세요.');
    missing.code = 'AUTH_SESSION_MISSING';
    throw missing;
  }
  if (error) throw error;
  const authenticatedUserId = data?.user?.id;
  if (typeof authenticatedUserId !== 'string') {
    const missing = Error('로그인 세션을 확인할 수 없습니다. 다시 로그인해 주세요.');
    missing.code = 'AUTH_SESSION_MISSING';
    throw missing;
  }
  if (authenticatedUserId !== userId) {
    const mismatch = Error('로그인 세션과 계정이 일치하지 않습니다. 다시 로그인해 주세요.');
    mismatch.code = 'AUTH_SESSION_MISMATCH';
    throw mismatch;
  }
  return authenticatedUserId;
}

export function supabaseErrorDiagnostic(error) {
  const redact = value => String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [가림]')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '[토큰]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[이메일]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[사용자ID]')
    .replace(/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g, '[좌표]')
    .slice(0, 240);
  return [
    ['code', error?.code || error?.statusCode || error?.status],
    ['message', error?.message],
    ['details', error?.details],
    ['hint', error?.hint],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${redact(value)}`)
    .join(' · ');
}

function favoritePayload(route) {
  if (!route?.restorable || typeof route.startName !== 'string' || typeof route.endName !== 'string') {
    throw Error('검색 목록에서 선택한 출발지와 도착지가 있는 경로만 저장할 수 있어요.');
  }
  const payload = { start_name: route.startName.trim(), end_name: route.endName.trim() };
  if (payload.start_name.length < 1 || payload.start_name.length > 200 || payload.end_name.length < 1 || payload.end_name.length > 200) {
    throw Error('출발지와 도착지 이름은 1~200자로 입력해 주세요.');
  }
  return payload;
}

const duplicateError = error => error?.code === '23505';
const validFavoriteId = id => (typeof id === 'string' && id.trim().length > 0)
  || (typeof id === 'number' && Number.isSafeInteger(id) && id > 0);

export async function listFavorites(client, userId) {
  requireUser(userId);
  const { data, error } = await client.from('favorites')
    .select('id,start_name,end_name,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function listReports(client, userId) {
  requireUser(userId);
  const { data, error } = await client.from('reports')
    .select('id,report_type,latitude,longitude,description,status,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveFavorite(client, userId, route) {
  const ownerId = await requireAuthenticatedOwner(client, userId);
  const payload = favoritePayload(route);
  const { data: existing, error: lookupError } = await client.from('favorites')
    .select('id')
    .eq('user_id', ownerId)
    .eq('start_name', payload.start_name)
    .eq('end_name', payload.end_name)
    .limit(1);
  if (lookupError) throw lookupError;
  if (existing?.length) return { status: 'duplicate' };
  const { data, error } = await client.from('favorites').insert({ ...payload, user_id: ownerId }).select('id').single();
  if (duplicateError(error)) return { status: 'duplicate' };
  if (error) throw error;
  if (!data?.id) throw Error('즐겨찾기 저장 결과를 확인하지 못했어요.');
  return { status: 'saved', id: data.id };
}

export async function updateFavorite(client, userId, favoriteId, route) {
  const ownerId = await requireAuthenticatedOwner(client, userId);
  if (!validFavoriteId(favoriteId)) throw Error('수정할 즐겨찾기를 찾지 못했어요.');
  const payload = favoritePayload(route);
  const { data: existing, error: lookupError } = await client.from('favorites')
    .select('id')
    .eq('user_id', ownerId)
    .eq('start_name', payload.start_name)
    .eq('end_name', payload.end_name)
    .neq('id', favoriteId)
    .limit(1);
  if (lookupError) throw lookupError;
  if (existing?.length) return { status: 'duplicate' };
  const { data, error } = await client.from('favorites')
    .update(payload)
    .eq('id', favoriteId)
    .eq('user_id', ownerId)
    .select('id');
  if (duplicateError(error)) return { status: 'duplicate' };
  if (error) throw error;
  if (!data?.length) return { status: 'not-found' };
  return { status: 'updated' };
}

export async function deleteFavorite(client, userId, favoriteId) {
  const ownerId = await requireAuthenticatedOwner(client, userId);
  if (!validFavoriteId(favoriteId)) throw Error('삭제할 즐겨찾기를 찾지 못했어요.');
  const { data, error } = await client.from('favorites')
    .delete()
    .eq('id', favoriteId)
    .eq('user_id', ownerId)
    .select('id');
  if (error) throw error;
  if (!data?.length) return { status: 'not-found' };
  return { status: 'deleted' };
}

export async function submitReport(client, userId, values) {
  const ownerId = await requireAuthenticatedOwner(client, userId);
  const reportType = values?.reportType;
  const latitudeText = String(values?.latitude ?? '').trim();
  const longitudeText = String(values?.longitude ?? '').trim();
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  const description = String(values?.description ?? '').trim();
  if (!reportTypes.has(reportType) || !latitudeText || !longitudeText || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || description.length < 5 || description.length > 1000) {
    throw Error('유형, 유효한 위도·경도, 5~1000자 설명을 확인해 주세요.');
  }
  const payload = { user_id: ownerId, report_type: reportType, latitude, longitude, description };
  const { data, error } = await client.from('reports').insert(payload).select('id').single();
  if (error) throw error;
  if (!data?.id) throw Error('제보 저장 결과를 확인하지 못했어요.');
  return { id: data.id };
}
