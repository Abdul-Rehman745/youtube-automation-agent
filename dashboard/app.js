const ui = {
  state: null,
  currentView: 'overview',
  refreshing: false,
  toastTimer: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function apiKey() {
  return localStorage.getItem('yaa_api_key') || '';
}

function requestApiKey() {
  const key = prompt('Enter the API_KEY value from your .env. It stays in this browser only.', apiKey());
  if (key !== null) localStorage.setItem('yaa_api_key', key.trim());
  return key;
}

async function api(url, options = {}, retry = true) {
  const key = apiKey();
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'x-api-key': key } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401 && retry && requestApiKey() !== null) return api(url, options, false);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || response.statusText || 'Request failed');
    error.data = data;
    throw error;
  }
  return data;
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => toast.classList.add('hidden'), 4200);
}

function empty(message) {
  return `<div class="empty">${escapeHTML(message)}</div>`;
}

function formatDate(value, includeTime = true) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not scheduled';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric',
    ...(ui.state?.profile?.timezone ? { timeZone: ui.state.profile.timezone } : {}),
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {})
  }).format(date);
}

function timeAgo(value) {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function label(value) {
  return String(value || 'unknown').replaceAll('_', ' ');
}

function statusChip(value) {
  const safe = String(value || 'unknown').toLowerCase();
  return `<span class="status ${escapeHTML(safe)}">${escapeHTML(label(safe))}</span>`;
}

async function refreshDashboard(silent = false) {
  if (ui.refreshing) return;
  ui.refreshing = true;
  if (!silent) $('#loading').classList.add('active');
  try {
    ui.state = await api('/api/dashboard');
    renderDashboard();
  } catch (error) {
    $('#system-label').textContent = 'Dashboard unavailable';
    $('#system-dot').classList.remove('online');
    if (!silent) showToast(error.message, 'error');
  } finally {
    ui.refreshing = false;
    $('#loading').classList.remove('active');
  }
}

function renderDashboard() {
  const state = ui.state;
  const reviews = state.pipeline.filter(item => ['needs_review', 'needs_attention'].includes(item.review_status));
  const scheduled = state.schedule.filter(item => item.status === 'scheduled');
  const activeJobs = state.jobs.filter(job => ['queued', 'running'].includes(job.status));

  $('#brand-name').textContent = state.profile?.channel_name || 'Automation Studio';
  $('#setup-banner').classList.toggle('hidden', !state.system.setupRequired);
  $('#system-label').textContent = state.system.setupRequired
    ? 'Setup required'
    : state.system.automationPaused ? 'Automation paused' : `${state.system.agents.length} agents online`;
  $('#system-dot').classList.toggle('online', state.system.initialized && !state.system.automationPaused && !state.system.setupRequired);
  $('#automation-toggle').textContent = state.system.automationPaused ? 'Resume automation' : 'Pause automation';
  $('#automation-toggle').disabled = state.system.setupRequired;
  $('#generate-button').disabled = state.system.setupRequired;
  $('#review-badge').textContent = reviews.length;
  $('#review-badge').classList.toggle('hidden', reviews.length === 0);

  $('#stat-review').textContent = reviews.length;
  $('#stat-scheduled').textContent = scheduled.length;
  $('#stat-published').textContent = state.stats.published || 0;
  $('#stat-score').textContent = state.analytics.averagePerformanceScore ? `${state.analytics.averagePerformanceScore}/100` : '—';

  renderReviews(reviews);
  renderJobs(activeJobs.length ? activeJobs : state.jobs.slice(0, 5));
  renderSchedule(state.schedule.slice(0, 5), '#next-schedule');
  renderNotifications(state.notifications, state.events);
  renderPipeline(state.pipeline);
  renderCalendar(state.schedule);
  renderIdeas(state.ideas);
  renderAnalytics(state.analytics);
  renderActivation(state.activation);
  populateSettings(state.profile, state.settings);
}

function renderReviews(reviews) {
  const container = $('#review-list');
  if (!reviews.length) {
    container.innerHTML = empty('Nothing is waiting. New content will appear here after quality review.');
    return;
  }
  container.innerHTML = reviews.slice(0, 5).map(item => `
    <article class="review-card">
      ${item.hasThumbnail ? `<img class="review-thumb" src="/api/content/${encodeURIComponent(item.id)}/asset/thumbnail" alt="">` : '<div class="review-thumb"></div>'}
      <div class="review-meta"><strong>${escapeHTML(item.title)}</strong><div class="meta-line">${statusChip(item.review_status)} · Quality ${qualityScore(item.qualityChecks)}%</div></div>
      <button class="button secondary small" data-open-content="${escapeHTML(item.id)}">Review</button>
    </article>`).join('');
}

function renderJobs(jobs) {
  const container = $('#job-list');
  if (!jobs.length) {
    container.innerHTML = empty('No generation runs yet.');
    return;
  }
  container.innerHTML = jobs.slice(0, 6).map(job => `
    <article class="job-card">
      <div class="job-meta">
        <strong>${escapeHTML(job.title || job.topic || 'Agent-selected topic')}</strong>
        <div class="meta-line">${statusChip(job.status)} · ${escapeHTML(label(job.stage))} · ${timeAgo(job.updated_at)}</div>
        <div class="progress"><i style="width:${Math.max(0, Math.min(100, job.progress || 0))}%"></i></div>
      </div>
      ${['queued', 'running'].includes(job.status) ? `<button class="text-button" data-cancel-job="${escapeHTML(job.id)}">Cancel</button>` : ''}
    </article>`).join('');
}

function renderSchedule(schedule, selector) {
  const container = $(selector);
  if (!schedule.length) {
    container.innerHTML = empty('No approved videos are scheduled.');
    return;
  }
  container.innerHTML = schedule.map(item => `
    <div class="timeline-item">
      <div class="date-chip"><small>${escapeHTML(new Date(item.publish_time).toLocaleDateString(undefined, { month: 'short' }))}</small><strong>${escapeHTML(new Date(item.publish_time).getDate())}</strong></div>
      <div class="timeline-meta"><strong>${escapeHTML(item.title)}</strong><div class="meta-line">${formatDate(item.publish_time)} · ${statusChip(item.status)}</div></div>
      <button class="text-button" data-open-content="${escapeHTML(item.production_id)}">View</button>
    </div>`).join('');
}

function renderNotifications(notifications, events) {
  const items = notifications.length
    ? notifications
    : events.map(event => ({ level: event.status === 'error' ? 'error' : 'info', title: label(event.event_type), message: event.data?.error || label(event.status), created_at: event.created_at }));
  const container = $('#notification-list');
  if (!items.length) {
    container.innerHTML = empty('No activity has been recorded yet.');
    return;
  }
  container.innerHTML = items.slice(0, 7).map(item => `
    <div class="activity ${escapeHTML(item.level || 'info')}"><i></i><p><strong>${escapeHTML(item.title)}</strong><br><span class="meta-line">${escapeHTML(item.message)}</span></p><small>${timeAgo(item.created_at)}</small></div>`).join('');
}

function currentPipelineFilter() {
  return $('#pipeline-filter').value || 'all';
}

function renderPipeline(items) {
  const filter = currentPipelineFilter();
  const filtered = filter === 'all' ? items : items.filter(item =>
    item.review_status === filter || item.schedule_status === filter || item.status === filter
  );
  const container = $('#pipeline-list');
  if (!filtered.length) {
    container.innerHTML = empty('No content matches this view.');
    return;
  }
  container.innerHTML = filtered.map(item => {
    const state = item.schedule_status || item.review_status || item.status;
    const next = nextAction(item);
    return `<article class="pipeline-item" data-open-content="${escapeHTML(item.id)}">
      <div class="pipeline-title"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.topic || 'No topic recorded')} · ${formatDate(item.created_at)}</span></div>
      <div class="pipeline-col"><span>State</span><strong>${statusChip(state)}</strong></div>
      <div class="pipeline-col"><span>Quality</span><strong>${qualityScore(item.qualityChecks)} / 100</strong></div>
      <button class="button secondary small">${escapeHTML(next)} →</button>
    </article>`;
  }).join('');
}

function qualityScore(checks) {
  if (!Array.isArray(checks) || !checks.length) return 0;
  return Math.round((checks.filter(check => check.passed).length / checks.length) * 100);
}

function nextAction(item) {
  if (item.schedule_status === 'published') return 'View';
  if (item.review_status === 'needs_attention') return 'Fix issues';
  if (item.review_status === 'needs_review') return 'Review';
  if (item.schedule_status === 'scheduled') return 'Scheduled';
  return 'Inspect';
}

function renderCalendar(schedule) {
  renderSchedule(schedule, '#calendar-list');
}

function renderIdeas(ideas) {
  const container = $('#idea-list');
  if (!ideas.length) {
    container.innerHTML = empty('Add promising topics here before spending generation credits.');
    return;
  }
  container.innerHTML = ideas.map(idea => `
    <article class="idea-card">
      <div class="idea-meta"><strong>${escapeHTML(idea.topic)}</strong><div class="meta-line">${escapeHTML(idea.angle || idea.rationale || 'No angle added')} · ${statusChip(idea.status)}</div></div>
      ${idea.status === 'backlog' ? `<button class="button secondary small" data-generate-idea="${escapeHTML(idea.id)}">Generate</button>` : ''}
    </article>`).join('');
}

function renderAnalytics(analytics) {
  $('#analytics-total').textContent = analytics.totalVideos || 0;
  $('#analytics-score').textContent = analytics.averagePerformanceScore ? `${analytics.averagePerformanceScore}/100` : '—';
  const insights = Array.isArray(analytics.insights) ? analytics.insights : [];
  $('#analytics-action').textContent = insights[0] || (analytics.totalVideos
    ? 'Keep collecting results; recommendations get stronger with more published videos.'
    : 'Publish and analyze the first video to unlock performance recommendations.');
  const performers = Array.isArray(analytics.topPerformers) ? analytics.topPerformers : [];
  $('#top-performers').innerHTML = performers.length ? performers.map(item => `
    <article class="performer-card"><strong>${escapeHTML(item.videoDetails?.title || item.title || 'Untitled video')}</strong><div class="meta-line">Performance ${escapeHTML(item.performance?.score ?? item.performance_score ?? '—')} / 100</div></article>`).join('') : empty('No analyzed videos yet.');
}

function renderActivation(activation = {}) {
  const container = $('#activation-list');
  if (!container) return;
  const milestones = activation.milestones || {};
  const rows = [
    ['Setup ready', milestones.setupReady],
    ['First real MP4', milestones.firstRealVideo],
    ['First approval', milestones.firstApproval],
    ['First YouTube publish', milestones.firstPublish],
    ['Second real MP4', milestones.secondRealVideo]
  ];
  container.innerHTML = rows.map(([name, milestone = {}]) => `
    <div class="timeline-item">
      <div class="timeline-dot ${milestone.achieved ? 'done' : ''}"></div>
      <div><strong>${escapeHTML(name)}</strong><div class="meta-line">${milestone.achieved ? escapeHTML(formatDate(milestone.at)) : 'Not reached yet'}</div></div>
    </div>`).join('');
  if (milestones.firstRealVideo?.achieved) {
    container.insertAdjacentHTML('beforeend', `
      <div class="activation-share">
        <span>Made something real with Lumen?</span>
        <a class="button secondary small" href="https://github.com/darkzOGx/youtube-automation-agent/discussions/new?category=show-and-tell" target="_blank" rel="noreferrer">Share what you built</a>
      </div>`);
  }
}

function populateSettings(profile = {}, settings = {}) {
  const form = $('#profile-form');
  const mapping = {
    channelName: profile.channel_name,
    goal: profile.goal,
    targetAudience: profile.target_audience,
    brandVoice: profile.brand_voice,
    defaultStyle: profile.default_style,
    callToAction: profile.call_to_action,
    visualStyle: profile.visual_style,
    timezone: profile.timezone,
    bannedTopics: (profile.bannedTopics || []).join(', ')
  };
  for (const [name, value] of Object.entries(mapping)) {
    if (form.elements[name] && document.activeElement !== form.elements[name]) form.elements[name].value = value || '';
  }
  $('#approval-required').checked = settings.approval_required !== 'false';
  $('#notifications-enabled').checked = settings.notification_enabled !== 'false';
}

function switchView(view) {
  ui.currentView = view;
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach(item => item.classList.toggle('active', item.id === `${view}-view`));
  const titles = {
    overview: ['OPERATOR OVERVIEW', 'Know what happens next.'],
    pipeline: ['CONTENT OPERATIONS', 'From idea to published.'],
    calendar: ['EDITORIAL PLANNING', 'Plan before you generate.'],
    analytics: ['PERFORMANCE', 'Turn results into the next move.'],
    settings: ['CHANNEL GUARDRAILS', 'Make every agent sound like you.']
  };
  $('#view-eyebrow').textContent = titles[view][0];
  $('#view-title').textContent = titles[view][1];
  location.hash = view;
}

async function openContent(productionId) {
  $('#loading').classList.add('active');
  try {
    const item = await api(`/api/content/${encodeURIComponent(productionId)}`);
    const data = item.editorData || {};
    const title = data.title || item.seo?.title || item.script?.title || item.strategy?.topic || 'Untitled content';
    const description = data.description || item.seo?.description || '';
    const tags = data.tags || item.seo?.tags || [];
    const publishTime = data.publishTime || item.schedule?.publish_time || item.scheduled_publish_time;
    const canReview = !['published'].includes(item.schedule?.status);
    $('#content-detail').innerHTML = `
      <div class="dialog-heading"><div><p class="eyebrow">CONTENT REVIEW</p><h2>${escapeHTML(title)}</h2><div class="meta-line">${statusChip(item.schedule?.status || item.review_status || item.status)} · Quality ${qualityScore(item.qualityChecks)}%</div></div><button type="button" class="close-button" data-close>×</button></div>
      <div class="content-layout">
        <div>
          <div class="preview">${item.assetUrls.video ? `<video controls preload="metadata" poster="${item.assetUrls.thumbnail || ''}"><source src="${item.assetUrls.video}" type="video/mp4"></video>` : item.assetUrls.thumbnail ? `<img src="${item.assetUrls.thumbnail}" alt="Generated thumbnail">` : '<div class="preview-placeholder">No playable preview was produced.</div>'}</div>
          <div class="quality-grid">${(item.qualityChecks || []).map(check => `<div class="quality-check ${check.passed ? 'pass' : 'fail'}">${check.passed ? '✓' : '×'} ${escapeHTML(check.message)}</div>`).join('') || '<div class="quality-check">No quality results recorded.</div>'}</div>
          ${item.review_notes ? `<p class="callout">${escapeHTML(item.review_notes)}</p>` : ''}
        </div>
        <form id="content-review-form" class="editor">
          <label><span>Title</span><input name="title" maxlength="100" value="${escapeHTML(title)}" required></label>
          <label><span>Description</span><textarea name="description" rows="7">${escapeHTML(description)}</textarea></label>
          <label><span>Tags</span><input name="tags" value="${escapeHTML(tags.join(', '))}"></label>
          <div class="form-grid two">
            <label><span>Publish time</span><input name="publishTime" type="datetime-local" value="${toLocalInput(publishTime)}"></label>
            <label><span>Privacy</span><select name="privacyStatus"><option value="private" ${data.privacyStatus === 'private' ? 'selected' : ''}>Private</option><option value="unlisted" ${data.privacyStatus === 'unlisted' ? 'selected' : ''}>Unlisted</option><option value="public" ${data.privacyStatus === 'public' ? 'selected' : ''}>Public</option></select></label>
          </div>
          <div class="settings-row">
            <label class="toggle"><input name="factChecked" type="checkbox" ${data.factChecked ? 'checked' : ''}><span></span> Facts and claims reviewed</label>
            <label class="toggle"><input name="rightsConfirmed" type="checkbox" ${data.rightsConfirmed ? 'checked' : ''}><span></span> Media rights confirmed</label>
          </div>
          ${canReview ? `<div class="form-actions"><button type="button" class="button primary" data-approve-content="${escapeHTML(item.id)}">Approve & schedule</button><button type="button" class="button secondary" data-save-content="${escapeHTML(item.id)}">Save draft</button><button type="button" class="button danger" data-reject-content="${escapeHTML(item.id)}">Reject</button><button type="button" class="button ghost" data-retry-content="${escapeHTML(item.id)}">Regenerate</button></div>` : `<a class="button secondary" href="${escapeHTML(item.schedule?.youtube_url || '#')}" target="_blank" rel="noopener">Open on YouTube</a>`}
        </form>
      </div>`;
    $('#content-dialog').showModal();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#loading').classList.remove('active');
  }
}

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60000;
  return escapeHTML(new Date(date.getTime() - offset).toISOString().slice(0, 16));
}

function contentFormData() {
  const form = $('#content-review-form');
  const values = Object.fromEntries(new FormData(form));
  return {
    title: values.title,
    description: values.description,
    tags: values.tags,
    publishTime: values.publishTime ? new Date(values.publishTime).toISOString() : undefined,
    privacyStatus: values.privacyStatus,
    factChecked: form.elements.factChecked?.checked || false,
    rightsConfirmed: form.elements.rightsConfirmed?.checked || false
  };
}

async function mutate(url, method, body, successMessage) {
  $('#loading').classList.add('active');
  try {
    const result = await api(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    showToast(successMessage);
    await refreshDashboard(true);
    return result;
  } catch (error) {
    const failures = error.data?.quality?.blockingFailures;
    showToast(failures ? `${error.message}: ${failures.join(', ')}` : error.message, 'error');
    throw error;
  } finally {
    $('#loading').classList.remove('active');
  }
}

document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]');
  if (nav) return switchView(nav.dataset.view);
  const go = event.target.closest('[data-go]');
  if (go) return switchView(go.dataset.go);
  if (event.target.closest('[data-close]')) return event.target.closest('dialog').close();

  const open = event.target.closest('[data-open-content]');
  if (open) return openContent(open.dataset.openContent);

  const cancel = event.target.closest('[data-cancel-job]');
  if (cancel && confirm('Cancel this generation job after its current stage?')) {
    await mutate(`/api/jobs/${encodeURIComponent(cancel.dataset.cancelJob)}/cancel`, 'POST', {}, 'Cancellation requested.').catch(() => {});
  }

  const idea = event.target.closest('[data-generate-idea]');
  if (idea) {
    await mutate(`/api/ideas/${encodeURIComponent(idea.dataset.generateIdea)}/generate`, 'POST', { length: 'medium' }, 'Idea queued for generation.').catch(() => {});
  }

  const save = event.target.closest('[data-save-content]');
  if (save) {
    await mutate(`/api/content/${encodeURIComponent(save.dataset.saveContent)}`, 'PATCH', contentFormData(), 'Draft saved.').catch(() => {});
  }

  const approve = event.target.closest('[data-approve-content]');
  if (approve) {
    try {
      await mutate(`/api/content/${encodeURIComponent(approve.dataset.approveContent)}/approve`, 'POST', contentFormData(), 'Content approved and scheduled.');
      $('#content-dialog').close();
    } catch (_error) { /* toast already shown */ }
  }

  const reject = event.target.closest('[data-reject-content]');
  if (reject) {
    const notes = prompt('Why are you rejecting this content?', 'Needs a different angle');
    if (notes !== null) {
      await mutate(`/api/content/${encodeURIComponent(reject.dataset.rejectContent)}/reject`, 'POST', { notes }, 'Content rejected.').catch(() => {});
      $('#content-dialog').close();
    }
  }

  const retry = event.target.closest('[data-retry-content]');
  if (retry && confirm('Generate a fresh version using the same topic?')) {
    await mutate(`/api/content/${encodeURIComponent(retry.dataset.retryContent)}/retry`, 'POST', {}, 'Regeneration started.').catch(() => {});
    $('#content-dialog').close();
  }
});

$('#generate-button').addEventListener('click', () => $('#generate-dialog').showModal());
$('#add-idea-button').addEventListener('click', () => $('#idea-dialog').showModal());
$('#refresh-button').addEventListener('click', () => refreshDashboard());
$('#pipeline-filter').addEventListener('change', () => renderPipeline(ui.state?.pipeline || []));

$('#automation-toggle').addEventListener('click', async () => {
  const action = ui.state?.system.automationPaused ? 'resume' : 'pause';
  await mutate(`/api/automation/${action}`, 'POST', {}, `Automation ${action}d.`).catch(() => {});
});

$('#generate-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await mutate('/generate', 'POST', { ...values, topic: values.topic.trim() || null }, 'Generation job started.');
    $('#generate-dialog').close();
    event.currentTarget.reset();
  } catch (_error) { /* toast already shown */ }
});

$('#idea-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await mutate('/api/ideas', 'POST', values, 'Idea added to the backlog.');
    $('#idea-dialog').close();
    event.currentTarget.reset();
  } catch (_error) { /* toast already shown */ }
});

$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  values.bannedTopics = values.bannedTopics.split(',').map(value => value.trim()).filter(Boolean);
  try {
    await mutate('/api/profile', 'PUT', values, 'Channel setup saved.');
    await mutate('/api/settings', 'PUT', {
      approval_required: $('#approval-required').checked,
      notification_enabled: $('#notifications-enabled').checked,
      channel_timezone: values.timezone
    }, 'Operator settings saved.');
  } catch (_error) { /* toast already shown */ }
});

$('#api-key-button').addEventListener('click', () => {
  if (requestApiKey() !== null) showToast('Dashboard API key saved in this browser.');
});

const initialView = location.hash.slice(1);
if (['overview', 'pipeline', 'calendar', 'analytics', 'settings'].includes(initialView)) switchView(initialView);
refreshDashboard();
setInterval(() => refreshDashboard(true), 8000);
