import { supabase, supabaseConfigured } from './supabase-client.mjs';
import { avatarExtensions, isValidAvatarFileHeader, userAvatarPath } from './avatar-utils.mjs';
import { deleteFavorite, deleteReport, filterFavorites, filterReports, listFavorites, listReports, saveFavorite, submitReport, supabaseErrorDiagnostic, updateFavorite, updateReport } from './supabase-account.mjs';

const $ = selector => document.querySelector(selector);
const avatarPathFor = userAvatarPath;
const reportTypeNames = {
  streetlight: '가로등',
  sidewalk: '보행로',
  crossing: '횡단보도',
  cctv: 'CCTV·안심벨',
  other: '기타',
};
const reportStatusNames = {
  pending: '접수',
  reviewing: '확인 중',
  resolved: '처리 완료',
  rejected: '반영 어려움',
};

function showMessage(selector, message, error = false) {
  const element = $(selector);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', error);
}

function authErrorMessage(error) {
  const text = (error?.message || '').toLowerCase();
  if (text.includes('redirect') && (text.includes('allow') || text.includes('url'))) return '인증 후 이동 주소가 Supabase 허용 목록에 없습니다. Authentication의 URL Configuration에 현재 웹앱 주소를 등록해 주세요.';
  if (text.includes('code verifier') || text.includes('otp_expired') || text.includes('expired') || text.includes('invalid token')) return '인증 링크가 만료됐거나 이 브라우저의 세션과 맞지 않습니다. 웹앱에서 회원가입 또는 로그인을 다시 시작해 주세요.';
  if (text.includes('cannot read properties') || text.includes('null')) return '인증 응답에 로그인 세션이 없습니다. 이메일 링크를 다시 열거나 웹앱에서 로그인을 다시 시도해 주세요.';
  if (text.includes('invalid login credentials')) return '이메일 또는 비밀번호를 확인해 주세요.';
  if (text.includes('email not confirmed')) return '이메일 인증이 필요합니다. 받은 편지함을 확인해 주세요.';
  if (text.includes('already registered')) return '이미 가입된 이메일입니다. 로그인해 주세요.';
  if (text.includes('password')) return '비밀번호는 6자 이상 입력해 주세요.';
  return error?.message || '인증 요청을 완료하지 못했어요.';
}

function emailRedirectTo(){
  const origin=window.location.origin;
  if(!origin||origin==='null'||!/^https?:$/.test(window.location.protocol))throw Error('이메일 인증은 배포된 HTTPS 웹앱에서 시작해 주세요.');
  return new URL('/',origin).href;
}

function dataErrorMessage(error) {
  const text = (error?.message || '').toLowerCase();
  const diagnostic = supabaseErrorDiagnostic(error);
  const details = diagnostic ? ` (${diagnostic})` : '';
  if (error?.code === '42P01' || error?.code === 'PGRST205' || text.includes('schema cache') || text.includes('does not exist')) {
    return `Supabase 테이블을 찾을 수 없습니다. Supabase SQL Editor에서 supabase/schema.sql을 확인해 주세요.${details}`;
  }
  if (error?.code === 'AUTH_SESSION_MISSING' || error?.code === 'AUTH_SESSION_MISMATCH') {
    return `로그인 세션을 확인할 수 없어 저장하지 않았어요. 다시 로그인해 주세요.${details}`;
  }
  if (error?.code === '42501' || text.includes('row-level security') || text.includes('permission denied')) {
    return `저장 권한이 없습니다. 로그인 세션과 Supabase의 Row Level Security 정책을 확인해 주세요.${details}`;
  }
  return diagnostic || error?.message || '요청을 완료하지 못했어요.';
}

function makeButton(text, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

export async function initializeSupabaseUI({ getCurrentRoute, onLoadFavorite, onPickReportLocation }) {
  const authView = $('#cloud-auth-view');
  const accountView = $('#cloud-account-view');
  const configMessage = $('#cloud-config-message');
  const authConfigMessage = $('#auth-config-message');
  try {
    $('#cloud-redirect-help').textContent = `인증 후 이동 주소: ${emailRedirectTo()} · Supabase Auth의 URL Configuration에서 ${new URL('/**', window.location.origin).href}를 허용해 주세요.`;
  } catch (error) {
    $('#cloud-redirect-help').textContent = error.message;
  }

  let profileRequest = 0;
  let activeProfileKey = null;

  async function updateHeaderProfile(user) {
    const avatar = $('#nav-user-avatar');
    const headerPhoto = $('#nav-user-photo');
    const headerFallback = $('#nav-user-fallback');
    const currentPhoto = $('#profile-current-photo');
    const currentFallback = $('#profile-current-fallback');
    if (!avatar || !headerPhoto || !headerFallback) return false;
    const path = avatarPathFor(user);
    const metadata = user?.user_metadata || {};
    let externalUrl = null;
    const candidate = metadata.avatar_url || metadata.picture;
    if (!path && !metadata.avatar_cleared && typeof candidate === 'string' && candidate.trim()) {
      try {
        const parsed = new URL(candidate, window.location.href);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') externalUrl = parsed.href;
      } catch {}
    }
    const key = user ? `${user.id}:${path ? `storage:${path}` : externalUrl || 'default'}` : 'signed-out';
    if (key === activeProfileKey) return true;
    activeProfileKey = key;
    const request = ++profileRequest;
    avatar.hidden = !user;
    if ($('#profile-remove-photo')) $('#profile-remove-photo').hidden = !path && !externalUrl;
    for (const [photo, fallback] of [[headerPhoto, headerFallback], [currentPhoto, currentFallback]]) {
      if (!photo || !fallback) continue;
      photo.onload = null;
      photo.onerror = null;
      photo.hidden = true;
      photo.removeAttribute('src');
      fallback.hidden = false;
    }
    if (!user) return true;
    const applyPhotoUrl = photoUrl => {
      for (const [photo, fallback] of [[headerPhoto, headerFallback], [currentPhoto, currentFallback]]) {
        if (!photo || !fallback) continue;
        photo.onload = () => {
          if (request === profileRequest && photo.src === photoUrl) {
            photo.hidden = false;
            fallback.hidden = true;
          }
        };
        photo.onerror = () => {
          if (request === profileRequest && photo.src === photoUrl) {
            photo.hidden = true;
            fallback.hidden = false;
          }
        };
        photo.src = photoUrl;
      }
    };
    if (!path && externalUrl) {
      applyPhotoUrl(externalUrl);
      return true;
    }
    if (!path) return true;
    try {
      const { data, error } = await supabase.storage.from('avatars').createSignedUrl(path, 3600);
      if (request !== profileRequest) return false;
      if (error || typeof data?.signedUrl !== 'string') throw error || Error('프로필 사진 주소를 만들지 못했어요.');
      const signedUrl = new URL(data.signedUrl, window.location.href);
      if (signedUrl.protocol !== 'https:' && signedUrl.protocol !== 'http:') throw Error('프로필 사진 주소가 올바르지 않아요.');
      applyPhotoUrl(signedUrl.href);
      return true;
    } catch {
      if (request === profileRequest) showMessage('#profile-status', '프로필 사진을 불러오지 못했어요. Storage 설정과 접근 정책을 확인해 주세요.', true);
      return false;
    }
  }

  if (!supabaseConfigured || !supabase) {
    $('#cloud-status').textContent = 'Supabase 설정 필요';
    if ($('#nav-user-label')) $('#nav-user-label').textContent = '로그인';
    updateHeaderProfile(null);
    const message = '로그인 기능을 사용할 수 없습니다. Supabase 연결 설정을 확인해 주세요.';
    configMessage.textContent = message;
    authConfigMessage.textContent = message;
    authConfigMessage.hidden = false;
    configMessage.hidden = false;
    authView.hidden = true;
    accountView.hidden = true;
    return;
  }

  configMessage.hidden = true;
  authConfigMessage.hidden = true;
  accountView.hidden = true;
  $('#cloud-status').textContent = '로그인 상태를 확인하고 있어요.';

  let currentSession = null;
  let currentUserId = null;
  let currentAvatarPath = null;
  let hasSessionState = false;
  let dataRequest = 0;
  let favoriteRows = [];
  let reportRows = [];
  let favoriteSearch = '';
  let reportSearch = '';
  let editingReportId = null;
  let editingReportOwnerId = null;
  const reportEditDialog = $('#report-edit-dialog');

  function clearPrivateLists() {
    favoriteRows = [];
    reportRows = [];
    favoriteSearch = '';
    reportSearch = '';
    for (const selector of ['#favorites-search', '#reports-search']) {
      const input = $(selector);
      if (input) input.value = '';
    }
    for (const selector of ['#favorites-search-clear', '#reports-search-clear']) {
      const button = $(selector);
      if (button) button.hidden = true;
    }
    for (const [buttonSelector, contentSelector] of [['#favorites-collapse', '#favorites-content'], ['#reports-collapse', '#reports-content']]) {
      const button = $(buttonSelector);
      const content = $(contentSelector);
      if (button && content) {
        button.setAttribute('aria-expanded', 'true');
        button.textContent = '접기';
        content.hidden = false;
      }
    }
    if ($('#favorite-count')) $('#favorite-count').textContent = '0';
    if ($('#report-count')) $('#report-count').textContent = '0';
    $('#favorite-list').replaceChildren();
    $('#reports-list').replaceChildren();
    showMessage('#favorite-status', '');
    showMessage('#favorite-list-status', '');
    showMessage('#report-message', '');
    showMessage('#report-submit-message', '');
    if (reportEditDialog?.open) reportEditDialog.close();
    editingReportId = null;
    editingReportOwnerId = null;
  }

  function renderFavorites(rows) {
    favoriteRows = rows;
    const count = $('#favorite-count');
    if (count) count.textContent = String(favoriteRows.length);
    const visibleRows = filterFavorites(favoriteRows, favoriteSearch);
    const list = $('#favorite-list');
    list.replaceChildren();
    if (!favoriteRows.length) {
      const empty = document.createElement('li');
      empty.className = 'cloud-empty';
      empty.textContent = '저장된 경로가 없습니다.';
      list.append(empty);
      return;
    }
    if (!visibleRows.length) {
      const empty = document.createElement('li');
      empty.className = 'cloud-empty';
      empty.textContent = '검색 결과가 없습니다.';
      list.append(empty);
      return;
    }

    for (const row of visibleRows) {
      const item = document.createElement('li');
      item.className = 'cloud-record';
      const details = document.createElement('div');
      details.className = 'cloud-record-copy';
      const names = document.createElement('strong');
      names.textContent = `${row.start_name} → ${row.end_name}`;
      const date = document.createElement('small');
      date.textContent = new Date(row.created_at).toLocaleString('ko-KR');
      details.append(names, date);

      const actions = document.createElement('div');
      actions.className = 'cloud-record-actions';
      actions.append(makeButton('불러오기', 'cloud-secondary', async () => {
        try {
          await onLoadFavorite?.(row);
        } catch (error) {
          showMessage('#favorite-status', error.message || '경로를 불러오지 못했어요.', true);
        }
      }));
      actions.append(makeButton('현재 경로로 수정', 'cloud-secondary', async event => {
        const route = getCurrentRoute?.();
        const ownerId = currentUserId;
        if (!ownerId || !route) {
          showMessage('#favorite-status', '수정할 현재 경로를 먼저 계산해 주세요.', true);
          return;
        }
        if (!route.restorable) {
          showMessage('#favorite-status', '검색 목록에서 선택한 장소가 있는 경로만 저장할 수 있어요.', true);
          return;
        }
        const button = event.currentTarget;
        button.disabled = true;
        showMessage('#favorite-status', '즐겨찾기를 수정하는 중…');
        try {
          const result = await updateFavorite(supabase, ownerId, row.id, route);
          if (currentUserId !== ownerId) return;
          if (result.status === 'duplicate') {
            showMessage('#favorite-status', '같은 출발지와 도착지의 즐겨찾기가 이미 있어요.', true);
            return;
          }
          if (result.status === 'not-found') {
            showMessage('#favorite-status', '수정할 즐겨찾기를 찾지 못했어요.', true);
            return;
          }
          showMessage('#favorite-status', '현재 경로로 즐겨찾기를 수정했습니다.');
          await loadAccountData(ownerId);
        } catch (error) {
          if (currentUserId === ownerId) showMessage('#favorite-status', dataErrorMessage(error), true);
        } finally {
          button.disabled = false;
        }
      }));
      actions.append(makeButton('삭제', 'cloud-secondary cloud-delete', async event => {
        const button = event.currentTarget;
        const ownerId = currentUserId;
        button.disabled = true;
        try {
          const result = await deleteFavorite(supabase, ownerId, row.id);
          if (currentUserId !== ownerId) return;
          if (result.status === 'not-found') {
            showMessage('#favorite-status', '삭제할 즐겨찾기를 찾지 못했어요.', true);
            return;
          }
          showMessage('#favorite-status', '즐겨찾기를 삭제했습니다.');
          await loadAccountData(ownerId);
        } catch (error) {
          if (currentUserId === ownerId) showMessage('#favorite-status', dataErrorMessage(error), true);
        } finally {
          button.disabled = false;
        }
      }));
      item.append(details, actions);
      list.append(item);
    }
  }

  function renderReports(rows) {
    reportRows = rows;
    const count = $('#report-count');
    if (count) count.textContent = String(reportRows.length);
    const visibleRows = filterReports(reportRows, reportSearch, { reportTypes: reportTypeNames, reportStatuses: reportStatusNames });
    const list = $('#reports-list');
    list.replaceChildren();
    if (!reportRows.length) {
      const empty = document.createElement('li');
      empty.className = 'cloud-empty';
      empty.textContent = '등록한 제보가 없습니다.';
      list.append(empty);
      return;
    }
    if (!visibleRows.length) {
      const empty = document.createElement('li');
      empty.className = 'cloud-empty';
      empty.textContent = '검색 결과가 없습니다.';
      list.append(empty);
      return;
    }

    for (const row of visibleRows) {
      const item = document.createElement('li');
      item.className = 'cloud-record report-record';
      const details = document.createElement('div');
      details.className = 'cloud-record-copy';
      const title = document.createElement('strong');
      title.textContent = reportTypeNames[row.report_type] || row.report_type;
      const state = document.createElement('span');
      state.className = 'report-state';
      state.textContent = reportStatusNames[row.status] || row.status;
      const description = document.createElement('p');
      description.textContent = row.description;
      const location = document.createElement('small');
      location.textContent = `${Number(row.latitude).toFixed(5)}, ${Number(row.longitude).toFixed(5)} · ${new Date(row.created_at).toLocaleString('ko-KR')}`;
      details.append(title, state, description, location);
      const actions = document.createElement('div');
      actions.className = 'report-actions';
      actions.append(makeButton('수정', 'cloud-secondary', () => openReportEditor(row)));
      actions.append(makeButton('삭제', 'cloud-secondary cloud-delete', async event => {
        const ownerId = currentUserId;
        if (!ownerId || !currentSession?.user) {
          showMessage('#report-submit-message', '로그인 후 제보를 관리할 수 있어요.', true);
          return;
        }
        const summary = `${reportTypeNames[row.report_type] || row.report_type}\n${Number(row.latitude).toFixed(5)}, ${Number(row.longitude).toFixed(5)}\n${String(row.description).slice(0, 100)}`;
        if (!window.confirm(`${summary}\n\n이 제보를 삭제할까요?`)) return;
        const button = event.currentTarget;
        button.disabled = true;
        showMessage('#report-submit-message', '제보를 삭제하는 중…');
        try {
          const result = await deleteReport(supabase, ownerId, row.id);
          if (currentUserId !== ownerId) return;
          if (result.status === 'not-found') {
            showMessage('#report-submit-message', '삭제할 제보를 찾지 못했어요.', true);
            return;
          }
          await loadAccountData(ownerId);
          if (currentUserId === ownerId) showMessage('#report-submit-message', '제보를 삭제했습니다.');
        } catch (error) {
          if (currentUserId === ownerId) showMessage('#report-submit-message', dataErrorMessage(error), true);
        } finally {
          button.disabled = false;
        }
      }));
      item.append(details, actions);
      list.append(item);
    }
  }

  function clearReportEditor() {
    $('#report-edit-form')?.reset();
    showMessage('#report-edit-message', '');
    editingReportId = null;
    editingReportOwnerId = null;
  }

  function closeReportEditor() {
    if (reportEditDialog?.open) reportEditDialog.close();
    else clearReportEditor();
  }

  function openReportEditor(row) {
    if (!currentSession?.user || !currentUserId || !reportEditDialog) {
      showMessage('#report-submit-message', '로그인 후 제보를 수정할 수 있어요.', true);
      return;
    }
    editingReportId = row.id;
    editingReportOwnerId = currentUserId;
    $('#report-edit-type').value = row.report_type;
    $('#report-edit-latitude').value = String(row.latitude);
    $('#report-edit-longitude').value = String(row.longitude);
    $('#report-edit-description').value = row.description;
    showMessage('#report-edit-message', '');
    reportEditDialog.showModal();
  }

  $('#report-edit-close')?.addEventListener('click', closeReportEditor);
  $('#report-edit-cancel')?.addEventListener('click', closeReportEditor);
  reportEditDialog?.addEventListener('close', clearReportEditor);
  reportEditDialog?.addEventListener('click', event => {
    if (event.target === reportEditDialog) closeReportEditor();
  });
  $('#report-edit-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const ownerId = editingReportOwnerId;
    const reportId = editingReportId;
    if (!ownerId || !reportId || !currentSession?.user || currentUserId !== ownerId) {
      showMessage('#report-edit-message', '로그인 세션을 확인한 뒤 다시 시도해 주세요.', true);
      return;
    }
    const save = $('#report-edit-save');
    const cancel = $('#report-edit-cancel');
    save.disabled = true;
    cancel.disabled = true;
    showMessage('#report-edit-message', '제보를 저장하는 중…');
    try {
      const result = await updateReport(supabase, ownerId, reportId, {
        reportType: $('#report-edit-type').value,
        latitude: $('#report-edit-latitude').value,
        longitude: $('#report-edit-longitude').value,
        description: $('#report-edit-description').value,
      });
      if (currentUserId !== ownerId) return;
      if (result.status === 'not-found') {
        showMessage('#report-edit-message', '수정할 제보를 찾지 못했어요.', true);
        return;
      }
      closeReportEditor();
      await loadAccountData(ownerId);
      if (currentUserId === ownerId) showMessage('#report-submit-message', '제보를 수정했습니다.');
    } catch (error) {
      if (currentUserId === ownerId) showMessage('#report-edit-message', dataErrorMessage(error), true);
    } finally {
      save.disabled = false;
      cancel.disabled = false;
    }
  });

  const favoriteSearchInput = $('#favorites-search');
  const favoriteSearchClear = $('#favorites-search-clear');
  const reportSearchInput = $('#reports-search');
  const reportSearchClear = $('#reports-search-clear');
  favoriteSearchInput?.addEventListener('input', () => {
    favoriteSearch = favoriteSearchInput.value;
    if (favoriteSearchClear) favoriteSearchClear.hidden = !favoriteSearch.trim();
    renderFavorites(favoriteRows);
  });
  favoriteSearchClear?.addEventListener('click', () => {
    favoriteSearch = '';
    if (favoriteSearchInput) favoriteSearchInput.value = '';
    favoriteSearchClear.hidden = true;
    renderFavorites(favoriteRows);
    favoriteSearchInput?.focus();
  });
  reportSearchInput?.addEventListener('input', () => {
    reportSearch = reportSearchInput.value;
    if (reportSearchClear) reportSearchClear.hidden = !reportSearch.trim();
    renderReports(reportRows);
  });
  reportSearchClear?.addEventListener('click', () => {
    reportSearch = '';
    if (reportSearchInput) reportSearchInput.value = '';
    reportSearchClear.hidden = true;
    renderReports(reportRows);
    reportSearchInput?.focus();
  });
  for (const [buttonSelector, contentSelector] of [['#favorites-collapse', '#favorites-content'], ['#reports-collapse', '#reports-content']]) {
    const button = $(buttonSelector);
    const content = $(contentSelector);
    if (button && content) button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      content.hidden = expanded;
      button.textContent = expanded ? '펼치기' : '접기';
    });
  }

  async function loadAccountData(userId) {
    const request = ++dataRequest;
    if (!userId) return;
    showMessage('#favorite-list-status', '즐겨찾기를 불러오는 중…');
    showMessage('#report-message', '제보 내역을 불러오는 중…');
    const [favorites, reports] = await Promise.allSettled([listFavorites(supabase, userId), listReports(supabase, userId)]);
    if (request !== dataRequest || currentUserId !== userId) return;
    if (favorites.status === 'rejected') showMessage('#favorite-list-status', dataErrorMessage(favorites.reason), true);
    else {
      renderFavorites(favorites.value);
      showMessage('#favorite-list-status', `${favorites.value.length}개 경로`);
    }
    if (reports.status === 'rejected') showMessage('#report-message', dataErrorMessage(reports.reason), true);
    else {
      renderReports(reports.value);
      showMessage('#report-message', `${reports.value.length}개 제보`);
    }
  }

  function setSession(session) {
    const nextUserId = session?.user?.id || null;
    const nextAvatarPath = avatarPathFor(session?.user || null);
    const changed = !hasSessionState || nextUserId !== currentUserId;
    const profileUser = session?.user || null;
    currentSession = session;
    currentAvatarPath = nextAvatarPath;
    if (changed) {
      hasSessionState = true;
      currentUserId = nextUserId;
      dataRequest++;
      if ($('#nav-user-label')) $('#nav-user-label').textContent = nextUserId ? '내 계정' : '로그인';
      if ($('#nav-account')) {
        $('#nav-account').title = session?.user?.email || '로그인 및 계정';
        $('#nav-account').setAttribute('aria-controls', nextUserId ? 'panel-account' : 'auth-dialog');
        if (nextUserId) $('#nav-account').removeAttribute('aria-haspopup');
        else $('#nav-account').setAttribute('aria-haspopup', 'dialog');
      }
    }
    const expectedUserId = currentUserId;
    setTimeout(() => { if (currentUserId === expectedUserId) void updateHeaderProfile(profileUser); }, 0);
    if (!changed) return;
    if (!nextUserId) {
      authConfigMessage.hidden = true;
      accountView.hidden = true;
      authView.hidden = false;
      $('#account-email').textContent = '';
      clearPrivateLists();
      $('#cloud-status').textContent = '로그인이 필요합니다.';
      return;
    }
    authView.hidden = true;
    if ($('#auth-dialog')?.open) $('#auth-dialog').close();
    accountView.hidden = false;
    $('#account-email').textContent = session.user.email || '로그인 사용자';
    $('#cloud-status').textContent = 'Supabase에 로그인되어 있습니다.';
    showMessage('#auth-message', '');
    clearPrivateLists();
    setTimeout(() => loadAccountData(nextUserId), 0);
  }

  const profileInput = $('#profile-file-input');
  const profileEditor = $('#profile-editor');
  const profilePreview = $('#profile-preview');
  const profilePreviewWrap = $('#profile-preview-wrap');
  const profileSave = $('#profile-save-photo');
  const profileFileName = $('#profile-file-name');
  let selectedAvatarFile = null;
  let selectedAvatarPreviewUrl = null;
  let avatarBusy = false;

  function resetAvatarSelection() {
    if (selectedAvatarPreviewUrl) URL.revokeObjectURL(selectedAvatarPreviewUrl);
    selectedAvatarPreviewUrl = null;
    selectedAvatarFile = null;
    if (profileInput) profileInput.value = '';
    if (profilePreview) profilePreview.removeAttribute('src');
    if (profilePreviewWrap) profilePreviewWrap.hidden = true;
    if (profileFileName) profileFileName.textContent = '';
    if (profileSave) profileSave.disabled = true;
  }

  function setAvatarBusy(busy) {
    avatarBusy = busy;
    for (const selector of ['#profile-change-photo', '#profile-choose-file', '#profile-cancel-photo', '#profile-remove-photo', '#profile-file-input', '#cloud-logout']) {
      const element = $(selector);
      if (element) element.disabled = busy;
    }
    if (profileSave) profileSave.disabled = busy || !selectedAvatarFile;
  }

  function avatarErrorMessage(error) {
    const text = (error?.message || '').toLowerCase();
    if (text.includes('bucket') || error?.statusCode === '404') return '비공개 avatars 저장 공간을 찾지 못했어요. Supabase SQL Editor에서 supabase/avatar-storage.sql 설정을 적용해 주세요.';
    if (text.includes('row-level') || text.includes('permission') || text.includes('unauthorized') || error?.statusCode === '403') return '사진 저장 권한이 없어요. Supabase Storage의 사용자별 avatars 정책을 확인해 주세요.';
    return error?.message || '프로필 사진을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }

  async function inspectAvatarFile(file) {
    if (!file || !Object.hasOwn(avatarExtensions, file.type)) throw Error('JPG, PNG, WebP 이미지만 사용할 수 있어요.');
    if (!file.size || file.size > 5 * 1024 * 1024) throw Error('이미지 크기는 5MB 이하여야 해요.');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (!isValidAvatarFileHeader(file.type, file.size, bytes)) {
      throw Error('파일의 실제 이미지 형식이 선택한 형식과 달라요. 다른 파일을 골라 주세요.');
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => image.naturalWidth && image.naturalHeight && image.naturalWidth * image.naturalHeight <= 40000000
          ? resolve()
          : reject(Error('이미지 크기를 읽을 수 없거나 해상도가 너무 커요.'));
        image.onerror = () => reject(Error('이미지가 손상되었거나 읽을 수 없어요.'));
        image.src = objectUrl;
      });
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
    return objectUrl;
  }

  if (profileInput && profileEditor && profilePreview && profilePreviewWrap && profileSave && profileFileName) {
    const openFilePicker = () => {
      if (avatarBusy) return;
      profileEditor.hidden = false;
      profileInput.click();
    };
    $('#profile-change-photo')?.addEventListener('click', openFilePicker);
    $('#profile-choose-file')?.addEventListener('click', openFilePicker);
    profileInput.addEventListener('change', async () => {
      const file = profileInput.files?.[0];
      profileInput.value = '';
      if (!file || avatarBusy) return;
      resetAvatarSelection();
      profileEditor.hidden = false;
      const validatingUserId = currentUserId;
      showMessage('#profile-status', '이미지 파일을 확인하고 있어요.');
      try {
        const objectUrl = await inspectAvatarFile(file);
        if (validatingUserId !== currentUserId || !currentSession?.user) {
          URL.revokeObjectURL(objectUrl);
          throw Error('로그인 계정이 바뀌었어요. 다시 로그인해 주세요.');
        }
        selectedAvatarFile = file;
        selectedAvatarPreviewUrl = objectUrl;
        profilePreview.src = objectUrl;
        profilePreviewWrap.hidden = false;
        profileFileName.textContent = file.name;
        profileSave.disabled = false;
        showMessage('#profile-status', '미리보기를 확인한 뒤 사진 저장을 눌러 주세요.');
      } catch (error) {
        showMessage('#profile-status', error.message || '이미지를 확인하지 못했어요.', true);
      }
    });

    $('#profile-cancel-photo')?.addEventListener('click', () => {
      if (avatarBusy) return;
      resetAvatarSelection();
      profileEditor.hidden = true;
      showMessage('#profile-status', '변경을 취소했어요. 기존 프로필 사진은 유지됩니다.');
    });

    profileSave.addEventListener('click', async () => {
      if (avatarBusy || !selectedAvatarFile || !currentSession?.user || !currentUserId) return;
      const user = currentSession.user;
      const ownerId = currentUserId;
      const previousPath = currentAvatarPath;
      const token = globalThis.crypto?.randomUUID?.();
      if (!token) {
        showMessage('#profile-status', '안전한 파일 이름을 만들 수 없는 브라우저예요. 최신 브라우저에서 다시 시도해 주세요.', true);
        return;
      }
      const path = `${ownerId}/${token}.${avatarExtensions[selectedAvatarFile.type]}`;
      let uploaded = false;
      let metadataSaved = false;
      setAvatarBusy(true);
      showMessage('#profile-status', '사진을 비공개 저장 공간에 업로드하고 계정에 연결하고 있어요.');
      try {
        const { error: uploadError } = await supabase.storage.from('avatars').upload(path, selectedAvatarFile, {
          cacheControl: '3600',
          contentType: selectedAvatarFile.type,
          upsert: false,
        });
        if (uploadError) throw uploadError;
        uploaded = true;
        if (currentUserId !== ownerId) throw Error('계정이 바뀌어 저장을 중단했어요. 다시 확인해 주세요.');
        const metadata = { ...(user.user_metadata || {}), avatar_path: path, avatar_cleared: false };
        const { data, error } = await supabase.auth.updateUser({ data: metadata });
        if (error) throw error;
        metadataSaved = true;
        if (currentUserId !== ownerId) throw Error('계정이 바뀌었어요. 사진은 계정 경로에 저장되었지만 화면을 새로고침해 확인해 주세요.');
        const updatedUser = data?.user
          ? { ...data.user, user_metadata: { ...(data.user.user_metadata || {}), avatar_path: path, avatar_cleared: false } }
          : { ...user, user_metadata: metadata };
        currentSession = { ...currentSession, user: updatedUser };
        currentAvatarPath = path;
        const canDisplay = await updateHeaderProfile(updatedUser);
        resetAvatarSelection();
        profileEditor.hidden = true;
        showMessage('#profile-status', canDisplay
          ? '프로필 사진을 계정에 저장했어요.'
          : '사진과 계정 경로는 저장했지만 표시할 수 없어요. Storage 설정을 확인해 주세요.', !canDisplay);
        if (previousPath && previousPath !== path) {
          const { error: cleanupError } = await supabase.storage.from('avatars').remove([previousPath]);
          if (cleanupError) showMessage('#profile-status', '새 사진은 저장했지만 이전 파일 정리는 완료하지 못했어요.', true);
        }
      } catch (error) {
        if (uploaded && !metadataSaved && currentUserId === ownerId) {
          try { await supabase.storage.from('avatars').remove([path]); } catch {}
        }
        showMessage('#profile-status', avatarErrorMessage(error), true);
      } finally {
        setAvatarBusy(false);
      }
    });

    $('#profile-remove-photo')?.addEventListener('click', async () => {
      if (avatarBusy || !currentSession?.user || !currentUserId) return;
      const user = currentSession.user;
      const ownerId = currentUserId;
      const previousPath = currentAvatarPath;
      const existingMetadata = user.user_metadata || {};
      const hasCurrentImage = Boolean(previousPath || (!existingMetadata.avatar_cleared && (existingMetadata.avatar_url || existingMetadata.picture)));
      if (!hasCurrentImage) return;
      const metadata = { ...existingMetadata, avatar_path: null, avatar_cleared: true };
      setAvatarBusy(true);
      showMessage('#profile-status', '프로필 사진 설정을 지우고 있어요.');
      try {
        const { data, error } = await supabase.auth.updateUser({ data: metadata });
        if (error) throw error;
        if (currentUserId !== ownerId) throw Error('계정이 바뀌었어요. 다시 로그인해 확인해 주세요.');
        const updatedUser = data?.user
          ? { ...data.user, user_metadata: { ...(data.user.user_metadata || {}), avatar_path: null, avatar_cleared: true } }
          : { ...user, user_metadata: metadata };
        currentSession = { ...currentSession, user: updatedUser };
        currentAvatarPath = null;
        await updateHeaderProfile(updatedUser);
        resetAvatarSelection();
        profileEditor.hidden = true;
        const { error: removeError } = previousPath
          ? await supabase.storage.from('avatars').remove([previousPath])
          : { error: null };
        if (removeError && previousPath && currentUserId === ownerId) {
          const restoreMetadata = { ...(user.user_metadata || {}), avatar_path: previousPath, avatar_cleared: false };
          const { data: restoreData, error: restoreError } = await supabase.auth.updateUser({ data: restoreMetadata });
          if (!restoreError && currentUserId === ownerId) {
            const restoredUser = restoreData?.user
              ? { ...restoreData.user, user_metadata: { ...(restoreData.user.user_metadata || {}), avatar_path: previousPath, avatar_cleared: false } }
              : { ...user, user_metadata: restoreMetadata };
            currentSession = { ...currentSession, user: restoredUser };
            currentAvatarPath = previousPath;
            await updateHeaderProfile(restoredUser);
            showMessage('#profile-status', '사진 파일을 삭제하지 못해 기존 프로필 사진을 유지했어요. Storage 권한을 확인해 주세요.', true);
          } else {
            showMessage('#profile-status', '사진 설정은 기본으로 바뀌었지만 파일 정리에 실패했어요. Storage 권한을 확인해 주세요.', true);
          }
        } else {
          showMessage('#profile-status', removeError
            ? '기본 프로필로 바꿨지만 이전 파일 삭제는 완료하지 못했어요.'
            : '프로필 사진을 제거하고 기본 아이콘으로 바꿨어요.', Boolean(removeError));
        }
      } catch (error) {
        showMessage('#profile-status', avatarErrorMessage(error), true);
      } finally {
        setAvatarBusy(false);
      }
    });
  }

  $('#cloud-auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!email || password.length < 6) {
      showMessage('#auth-message', '이메일과 6자 이상의 비밀번호를 입력해 주세요.', true);
      return;
    }
    $('#auth-login').disabled = true;
    $('#auth-signup').disabled = true;
    showMessage('#auth-message', '로그인 중…');
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        showMessage('#auth-message', authErrorMessage(error), true);
        return;
      }
      if (!data?.session?.user) {
        showMessage('#auth-message', '로그인 세션을 확인하지 못했어요. 다시 시도해 주세요.', true);
        return;
      }
      setSession(data.session);
      showMessage('#auth-message', '로그인했습니다.');
    } catch (error) {
      showMessage('#auth-message', authErrorMessage(error), true);
    } finally {
      $('#auth-login').disabled = false;
      $('#auth-signup').disabled = false;
    }
  });

  $('#auth-signup').addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!email || password.length < 6) {
      showMessage('#auth-message', '이메일과 6자 이상의 비밀번호를 입력해 주세요.', true);
      return;
    }
    $('#auth-login').disabled = true;
    $('#auth-signup').disabled = true;
    showMessage('#auth-message', '가입 요청 중…');
    try {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: emailRedirectTo() } });
      if (error) {
        showMessage('#auth-message', authErrorMessage(error), true);
        return;
      }
      if (data.session) {
        setSession(data.session);
        showMessage('#auth-message', '회원가입 후 로그인했습니다.');
      } else {
        showMessage('#auth-message', '인증 메일을 보냈습니다. 이메일을 확인한 뒤 로그인해 주세요.');
      }
    } catch (error) {
      showMessage('#auth-message', authErrorMessage(error), true);
    } finally {
      $('#auth-login').disabled = false;
      $('#auth-signup').disabled = false;
    }
  });

  $('#cloud-logout').addEventListener('click', async () => {
    $('#cloud-logout').disabled = true;
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        showMessage('#cloud-status', authErrorMessage(error), true);
        return;
      }
      setSession(null);
      showMessage('#auth-message', '로그아웃했습니다.');
    } catch (error) {
      showMessage('#cloud-status', authErrorMessage(error), true);
    } finally {
      $('#cloud-logout').disabled = false;
    }
  });

  $('#save-favorite').addEventListener('click', async () => {
    if (!currentSession?.user) {
      showMessage('#favorite-status', '로그인 후 저장할 수 있어요.', true);
      return;
    }
    const ownerId = currentUserId;
    const route = getCurrentRoute?.();
    if (!route) {
      showMessage('#favorite-status', '먼저 경로를 계산해 주세요.', true);
      return;
    }
    if (!route.restorable) {
      showMessage('#favorite-status', '검색 목록에서 선택한 장소만 즐겨찾기로 저장할 수 있어요.', true);
      return;
    }
    $('#save-favorite').disabled = true;
    showMessage('#favorite-status', '즐겨찾기를 저장하는 중…');
    try {
      const result = await saveFavorite(supabase, ownerId, route);
      if (currentUserId !== ownerId) return;
      if (result.status === 'duplicate') {
        showMessage('#favorite-status', '이미 저장된 출발지와 도착지예요. 목록에서 불러오거나 수정해 주세요.', true);
        return;
      }
      showMessage('#favorite-status', '즐겨찾기에 저장했습니다.');
      await loadAccountData(ownerId);
    } catch (error) {
      if (currentUserId === ownerId) showMessage('#favorite-status', dataErrorMessage(error), true);
    } finally {
      $('#save-favorite').disabled = false;
    }
  });

  $('#pick-report-location').addEventListener('click', () => onPickReportLocation?.());
  $('#report-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentSession?.user) {
      showMessage('#report-submit-message', '로그인 후 제보를 등록할 수 있어요.', true);
      return;
    }
    const reportInput={reportType:$('#report-type').value,latitude:$('#report-latitude').value,longitude:$('#report-longitude').value,description:$('#report-description').value};
    const ownerId = currentUserId;
    $('#submit-report').disabled = true;
    showMessage('#report-submit-message', '제보 등록 중…');
    try {
      await submitReport(supabase, ownerId, reportInput);
      if (currentUserId !== ownerId) return;
      $('#report-form').reset();
      showMessage('#report-submit-message', '제보를 등록했습니다. 처리 상태는 아래 목록에서 확인할 수 있어요.');
      await loadAccountData(ownerId);
    } catch (error) {
      if (currentUserId === ownerId) showMessage('#report-submit-message', dataErrorMessage(error), true);
    } finally {
      $('#submit-report').disabled = false;
    }
  });

  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setSession(session));
  window.addEventListener('pagehide', () => subscription.unsubscribe(), { once: true });
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!hasSessionState) setSession(data.session);
  } catch (error) {
    $('#cloud-status').textContent = authErrorMessage(error);
    $('#cloud-status').classList.add('error');
    authView.hidden = false;
  }
}
