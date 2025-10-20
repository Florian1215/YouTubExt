(function () {
  if (window.__unhookDownloadButtonsLoaded) {
    return;
  }
  window.__unhookDownloadButtonsLoaded = true;

  const BUTTON_CONTAINER_ID = 'unhook-download-buttons';
  const BUTTON_CLASS = 'unhook-download-button';
  const VIDEO_BUTTON_ID = 'unhook-download-video';
  const AUDIO_BUTTON_ID = 'unhook-download-audio';
  const UPDATE_DEBOUNCE_MS = 200;
  const CHECK_INTERVAL_MS = 2000;
  const STATUS_POLL_INTERVAL_MS = 1000;

  let scheduledUpdate = null;
  let isUpdating = false;
  const activeRequests = new Map();

  window.addEventListener('message', onWindowMessage, false);

  scheduleUpdate();
  window.addEventListener('yt-page-data-updated', scheduleUpdate, true);
  window.addEventListener('yt-navigate-finish', scheduleUpdate, true);
  document.addEventListener('DOMContentLoaded', scheduleUpdate, { once: false });
  setInterval(scheduleUpdate, CHECK_INTERVAL_MS);

  function scheduleUpdate() {
    if (scheduledUpdate) {
      return;
    }
    scheduledUpdate = setTimeout(() => {
      scheduledUpdate = null;
      runUpdate();
    }, UPDATE_DEBOUNCE_MS);
  }

  async function runUpdate() {
    if (isUpdating) {
      return;
    }
    isUpdating = true;
    try {
      await updateButtons();
    } catch (error) {
      console.error('[Unhook] Failed to update download buttons', error);
    } finally {
      isUpdating = false;
    }
  }

  async function updateButtons() {
    if (!isOnWatchPage()) {
      removeButtons();
      return;
    }

    const placement = findButtonsHost();
    if (!placement || !placement.host) {
      return;
    }

    const container = ensureButtons(placement.host, placement.subscribeWrapper, placement.subscribeButton);
    const videoButton = container.querySelector(`#${VIDEO_BUTTON_ID}`);
    const audioButton = container.querySelector(`#${AUDIO_BUTTON_ID}`);

    const response = getPlayerResponse();
    const streamingData = response && response.streamingData;
    const videoDetails = response && response.videoDetails;

    const videoId = (videoDetails && videoDetails.videoId) || getVideoIdFromLocation();

    if (!streamingData) {
      setButtonLoading(videoButton, 'Chargement…');
      setButtonLoading(audioButton, 'Chargement…');
      return;
    }

    const title = (videoDetails && videoDetails.title) || getDocumentTitle();

    const bestVideoFormat = pickBestVideoFormat(streamingData);
    const bestAudioFormat = pickBestAudioFormat(streamingData);

    updateButton(videoButton, {
      format: bestVideoFormat,
      title,
      videoId,
      type: 'video'
    });

    updateButton(audioButton, {
      format: bestAudioFormat,
      title,
      videoId,
      type: 'audio'
    });
  }

  function isOnWatchPage() {
    return Boolean(document.querySelector('ytd-watch-flexy'));
  }

  function getDocumentTitle() {
    return document.title.replace(/ - YouTube$/i, '').trim();
  }

  function findButtonsHost() {
    const ownerContainer = document.querySelector('ytd-watch-metadata #owner.item.style-scope.ytd-watch-metadata');
    const subscribeWrapper = ownerContainer ? ownerContainer.querySelector('#subscribe-button') : null;
    const subscribeButton = subscribeWrapper ? subscribeWrapper.querySelector('button') : null;
    if (ownerContainer) {
      return { host: ownerContainer, subscribeWrapper, subscribeButton };
    }
    const fallbackSubscribeWrapper = document.querySelector('#subscribe-button');
    if (fallbackSubscribeWrapper) {
      return {
        host: fallbackSubscribeWrapper.parentElement || document.body,
        subscribeWrapper: fallbackSubscribeWrapper,
        subscribeButton: fallbackSubscribeWrapper.querySelector('button'),
      };
    }
    const fallback =
      document.querySelector('#actions.ytd-watch-metadata #top-level-buttons-computed') ||
      document.querySelector('#actions ytd-menu-renderer #top-level-buttons-computed') ||
      document.querySelector('ytd-watch-metadata #top-level-buttons-computed') ||
      document.querySelector('#above-the-fold #top-level-buttons-computed');
    return fallback ? { host: fallback, subscribeWrapper: null, subscribeButton: null } : null;
  }

  function ensureButtons(host, subscribeWrapper, subscribeButton) {
    let container = document.getElementById(BUTTON_CONTAINER_ID);
    if (!container) {
      container = document.createElement('div');
      container.id = BUTTON_CONTAINER_ID;
      container.className = 'style-scope ytd-menu-renderer unhook-download-buttons-container';
      container.appendChild(createButton('video'));
      container.appendChild(createButton('audio'));
    }
    if (subscribeWrapper && subscribeWrapper.parentElement) {
      const ownerContainer = subscribeWrapper.closest('#owner') || host;
      if (container.parentElement !== ownerContainer) {
        ownerContainer.appendChild(container);
      }
      if (subscribeWrapper.nextElementSibling !== container) {
        subscribeWrapper.insertAdjacentElement('afterend', container);
      }
    } else if (container.parentElement !== host) {
      host.appendChild(container);
    }
    const placement = subscribeWrapper ? 'subscribe' : host.closest && host.closest('ytd-video-owner-renderer') ? 'owner' : 'actions';
    container.dataset.location = placement;
    return container;
  }

  function createButton(type) {
    const button = document.createElement('button');
    button.id = type === 'video' ? VIDEO_BUTTON_ID : AUDIO_BUTTON_ID;
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.dataset.type = type;
    const icon = createIcon(type);

    const labelText = type === 'video' ? 'Télécharger vidéo' : 'Télécharger audio';
    const text = document.createElement('span');
    text.className = 'unhook-download-label';
    text.textContent = labelText;

    button.dataset.label = labelText;
    button.disabled = true;
    button.addEventListener('click', onDownloadClick);
    button.appendChild(icon);
    button.appendChild(text);
    return button;
  }

  function createIcon(type) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.classList.add('unhook-download-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (type === 'video') {
      path.setAttribute('d', 'M12 3a1 1 0 0 1 1 1v8.586l2.293-2.293a1 1 0 1 1 1.414 1.414l-4.001 4a1 1 0 0 1-1.412 0l-4.001-4a1 1 0 0 1 1.414-1.414L11 12.586V4a1 1 0 0 1 1-1ZM5 17a1 1 0 0 0 0 2h14a1 1 0 1 0 0-2H5Z');
    } else {
      path.setAttribute('d', 'M9 4a1 1 0 0 1 .707-.957l8-2A1 1 0 0 1 19 2v9.382a4.5 4.5 0 1 1-2-3.682V4.236l-6 1.5V15a4.5 4.5 0 1 1-2-3.682V4Z');
    }
    svg.appendChild(path);
    return svg;
  }

  function removeButtons() {
    const container = document.getElementById(BUTTON_CONTAINER_ID);
    if (container && container.parentElement) {
      container.parentElement.removeChild(container);
    }
  }

  function setButtonLoading(button, label) {
    if (!button) {
      return;
    }
    button.disabled = true;
    const labelNode = button.querySelector('.unhook-download-label');
    if (labelNode) {
      labelNode.textContent = label;
    }
    button.title = label;
    delete button.dataset.quality;
    button.dataset.videoId = '';
    button.dataset.title = '';
    delete button.dataset.fileUrl;
    delete button.dataset.completed;
  }

  function updateButton(button, data) {
    if (!button) {
      return;
    }

    if (!data.format) {
      button.disabled = true;
      const labelNode = button.querySelector('.unhook-download-label');
      if (labelNode) {
        labelNode.textContent = data.type === 'video' ? 'Vidéo indisponible' : 'Audio indisponible';
      }
      delete button.dataset.quality;
      delete button.dataset.videoId;
      delete button.dataset.title;
      delete button.dataset.label;
      delete button.dataset.fileUrl;
      delete button.dataset.completed;
      return;
    }

    const label = data.type === 'video' ? getVideoLabel(data.format) : getAudioLabel(data.format);
    button.disabled = false;
    button.dataset.quality = label;
    button.dataset.videoId = data.videoId || '';
    button.dataset.title = data.title || '';
    button.dataset.type = data.type;
    button.dataset.label = data.type === 'video' ? 'Télécharger vidéo' : 'Télécharger audio';
    const labelNode = button.querySelector('.unhook-download-label');
    if (labelNode) {
      labelNode.textContent = button.dataset.label;
    }
    button.title = button.dataset.label;
    delete button.dataset.fileUrl;
    delete button.dataset.completed;
  }

  function getVideoLabel(format) {
    if (format.qualityLabel) {
      const isVideoOnly = isVideoOnlyFormat(format);
      return isVideoOnly ? `${format.qualityLabel} (vidéo seule)` : format.qualityLabel;
    }
    const height = format.height || format.size || '';
    return height ? `${height}p` : 'qualité max';
  }

  function getAudioLabel(format) {
    if (format.audioQuality) {
      return format.audioQuality.replace('AUDIO_QUALITY_', '').toLowerCase();
    }
    if (format.bitrate) {
      return `${Math.round(format.bitrate / 1000)} kbps`;
    }
    return 'qualité max';
  }

  function isVideoOnlyFormat(format) {
    const mimeType = format.mimeType || '';
    return mimeType.startsWith('video/') && !/audio\//.test(mimeType);
  }

  function getPlayer() {
    const playerElement = document.querySelector('ytd-player');
    return playerElement && playerElement.player_ ? playerElement.player_ : null;
  }

  function getPlayerResponse() {
    const player = getPlayer();
    if (player && typeof player.getPlayerResponse === 'function') {
      return player.getPlayerResponse();
    }
    return window.ytInitialPlayerResponse || null;
  }

  function getVideoIdFromLocation() {
    const urlParams = new URLSearchParams(window.location.search || '');
    return urlParams.get('v');
  }

  function pickBestVideoFormat(streamingData) {
    const formats = (streamingData.formats || []).filter(Boolean);
    const adaptive = (streamingData.adaptiveFormats || []).filter(Boolean);

    const progressive = formats.filter((format) => {
      const mime = format.mimeType || '';
      return mime.startsWith('video/') && /audio\//.test(mime);
    });

    const withHeights = progressive.sort(compareVideoQuality);
    if (withHeights.length) {
      return withHeights[0];
    }

    const videoOnly = adaptive.filter((format) => {
      const mime = format.mimeType || '';
      return mime.startsWith('video/');
    }).sort(compareVideoQuality);

    return videoOnly.length ? videoOnly[0] : null;
  }

  function compareVideoQuality(a, b) {
    const heightA = a.height || parseQualityLabel(a.qualityLabel);
    const heightB = b.height || parseQualityLabel(b.qualityLabel);
    return heightB - heightA;
  }

  function parseQualityLabel(label) {
    if (!label) {
      return 0;
    }
    const match = label.match(/(\d{3,4})p/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function pickBestAudioFormat(streamingData) {
    const formats = (streamingData.adaptiveFormats || []).filter(Boolean);
    const audioOnly = formats.filter((format) => {
      const mime = format.mimeType || '';
      return mime.startsWith('audio/');
    });

    audioOnly.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return audioOnly.length ? audioOnly[0] : null;
  }

  function setButtonPending(button) {
    button.disabled = true;
    const labelNode = button.querySelector('.unhook-download-label');
    if (labelNode) {
      labelNode.textContent = 'Téléchargement…';
    }
    button.title = 'Téléchargement…';
    delete button.dataset.fileUrl;
    delete button.dataset.completed;
  }

  function restoreButtonLabel(button) {
    const label = button.dataset.label || (button.dataset.type === 'audio' ? 'Télécharger audio' : 'Télécharger vidéo');
    const labelNode = button.querySelector('.unhook-download-label');
    if (labelNode) {
      labelNode.textContent = label;
    }
    button.disabled = false;
    button.title = label;
  }

  function indicateFailure(button, message) {
    button.disabled = false;
    const labelNode = button.querySelector('.unhook-download-label');
    if (labelNode) {
      labelNode.textContent = 'Erreur téléchargement';
    }
    if (message) {
      button.title = message;
    }
    setTimeout(() => {
      restoreButtonLabel(button);
    }, 3000);
    delete button.dataset.fileUrl;
    delete button.dataset.completed;
  }

  function indicateSuccess(button) {
    button.disabled = true;
    const labelNode = button.querySelector('.unhook-download-label');
    if (labelNode) {
      labelNode.textContent = 'Téléchargement lancé';
    }
    button.title = 'Téléchargement lancé';
  }

  function showCompletion(button, message) {
    button.disabled = false;
    const labelNode = button.querySelector('.unhook-download-label');
    if (labelNode) {
      labelNode.textContent = message;
    }
    button.title = message;
    button.dataset.completed = 'true';
  }

  function onWindowMessage(event) {
    if (!event || event.source !== window) {
      return;
    }
    const data = event.data;
    if (!data || !data.direction) {
      return;
    }
    if (data.direction === 'unhook-download-response') {
      handleDownloadResponse(data.payload || {});
    } else if (data.direction === 'unhook-download-status-response') {
      handleStatusResponse(data.payload || {});
    }
  }

  function handleDownloadResponse(payload) {
    const requestId = payload.requestId;
    if (!requestId || !activeRequests.has(requestId)) {
      return;
    }
    const entry = activeRequests.get(requestId) || {};
    const { button } = entry;
    if (!button) {
      activeRequests.delete(requestId);
      return;
    }
    if (!payload.success) {
      clearStatusPolling(requestId);
      activeRequests.delete(requestId);
      indicateFailure(button, payload.error || payload.message);
      return;
    }

    indicateSuccess(button);
    entry.jobId = payload.jobId || null;
    entry.message = payload.message || null;
    entry.fileUrl = payload.downloadUrl || null;
    activeRequests.set(requestId, entry);
    if (entry.jobId) {
      startStatusPolling(requestId, entry.jobId);
    } else {
      clearStatusPolling(requestId);
      activeRequests.delete(requestId);
      if (payload.downloadUrl) {
        button.dataset.fileUrl = payload.downloadUrl;
      }
      showCompletion(button, payload.message || getCompletionMessage(entry.type));
    }
  }

  function handleStatusResponse(payload) {
    const requestId = payload.requestId;
    if (!requestId || !activeRequests.has(requestId)) {
      return;
    }
    const entry = activeRequests.get(requestId) || {};
    const { button, type } = entry;
    if (!button) {
      clearStatusPolling(requestId);
      activeRequests.delete(requestId);
      return;
    }
    if (!payload.success) {
      clearStatusPolling(requestId);
      activeRequests.delete(requestId);
      indicateFailure(button, payload.error || payload.message);
      return;
    }

    const status = payload.status || '';
    const message = payload.message || entry.message || null;

    if (status === 'queued') {
      button.disabled = true;
      const labelNode = button.querySelector('.unhook-download-label');
      if (labelNode) {
        labelNode.textContent = 'Téléchargement…';
      }
      button.title = 'Téléchargement…';
    } else if (status === 'downloading') {
      button.disabled = true;
      const labelNode = button.querySelector('.unhook-download-label');
      if (labelNode) {
        labelNode.textContent = 'Téléchargement…';
      }
      button.title = 'Téléchargement…';
    } else if (status === 'processing') {
      button.disabled = true;
      const labelNode = button.querySelector('.unhook-download-label');
      if (labelNode) {
        labelNode.textContent = 'Finalisation…';
      }
      button.title = 'Finalisation…';
    } else if (status === 'finished') {
      clearStatusPolling(requestId);
      activeRequests.delete(requestId);
      if (payload.downloadUrl) {
        button.dataset.fileUrl = payload.downloadUrl;
      }
      showCompletion(button, message || getCompletionMessage(type));
    } else if (status === 'error') {
      clearStatusPolling(requestId);
      activeRequests.delete(requestId);
      indicateFailure(button, message || payload.error || 'Erreur téléchargement');
    }
  }

  function startStatusPolling(requestId, jobId) {
    if (!jobId || !activeRequests.has(requestId)) {
      return;
    }
    const entry = activeRequests.get(requestId) || {};
    if (entry.intervalId) {
      clearInterval(entry.intervalId);
    }
    const poll = () => {
      requestStatusUpdate(requestId, jobId);
    };
    entry.intervalId = setInterval(poll, STATUS_POLL_INTERVAL_MS);
    entry.jobId = jobId;
    activeRequests.set(requestId, entry);
    poll();
  }

  function requestStatusUpdate(requestId, jobId) {
    window.postMessage({
      direction: 'unhook-download-status-request',
      payload: {
        requestId,
        jobId
      }
    }, '*');
  }

  function clearStatusPolling(requestId) {
    if (!activeRequests.has(requestId)) {
      return;
    }
    const entry = activeRequests.get(requestId);
    if (entry && entry.intervalId) {
      clearInterval(entry.intervalId);
      entry.intervalId = null;
      activeRequests.set(requestId, entry);
    }
  }

  function getCompletionMessage(type) {
    return 'Téléchargement terminé';
  }

  function onDownloadClick(event) {
    const button = event.currentTarget;
    if (!button || button.disabled) {
      return;
    }
    if (button.dataset.completed === 'true' && button.dataset.fileUrl) {
      event.preventDefault();
      window.open(button.dataset.fileUrl, '_blank');
      return;
    }
    event.preventDefault();
    const type = button.dataset.type || 'video';
    const quality = button.dataset.quality || '';
    const title = button.dataset.title || getDocumentTitle();
    const videoId = button.dataset.videoId || getVideoIdFromLocation();
    if (!videoId) {
      indicateFailure(button, 'ID introuvable');
      return;
    }

    const requestId = `unhook-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    activeRequests.set(requestId, { button, type, intervalId: null, jobId: null, message: null });
    setButtonPending(button);
    window.postMessage({
      direction: 'unhook-download-request',
      payload: {
        requestId,
        type,
        quality,
        title,
        videoId,
        pageUrl: window.location.href
      }
    }, '*');
  }
})();
