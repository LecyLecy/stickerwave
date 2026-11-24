(() => {
  const MIN_CLIP_SECONDS = 0.5

  const state = {
    maxDurationSeconds: 10,
    maxInputSizeMb: 20,
    defaultAuthor: 'Adin',
    wa: {
      state: 'connecting',
      connected: false,
      selfJidMasked: null,
      qrDataUrl: null,
      pairingCode: null,
      error: null
    },

    // Visual (strictly 1: either image OR video)
    visualFile: null,
    visualType: null, // 'image' | 'video' | null
    visualUrl: null,
    visualWidth: 0,
    visualHeight: 0,
    videoDuration: 0,
    videoStart: 0,
    videoEnd: 0,

    // Crop
    cropMode: 'center', // center | top | bottom | left | right | none | custom
    cropX: 0.5,
    cropY: 0.5,

    // Optional custom audio (overrides original video audio)
    audioFile: null,
    audioUrl: null,
    audioDuration: 0,
    audioStart: 0,
    audioEnd: 0,
    audioPeaks: null,

    // Playback
    isPlaying: false,
    loop: true,
    rafId: null,

    // Form
    stickerName: '',
    fps: 12,
    sending: false
  }

  // DOM helpers
  const $ = (id) => document.getElementById(id)

  const el = {
    connectGate: $('connectGate'),
    connectStatusDot: $('connectStatusDot'),
    connectStatusText: $('connectStatusText'),
    connectLoadingBox: $('connectLoadingBox'),
    connectLoadingMsg: $('connectLoadingMsg'),
    connectQrPanel: $('connectQrPanel'),
    connectQrImg: $('connectQrImg'),
    pairForm: $('pairForm'),
    pairPhoneInput: $('pairPhoneInput'),
    pairCodeBox: $('pairCodeBox'),

    studioApp: $('studioApp'),
    maxDurationBadge: $('maxDurationBadge'),
    waStatusDot: $('waStatusDot'),
    waStatusText: $('waStatusText'),
    logoutBtn: $('logoutBtn'),
    logoutModal: $('logoutModal'),
    closeLogoutModalBtn: $('closeLogoutModalBtn'),
    cancelLogoutBtn: $('cancelLogoutBtn'),
    confirmLogoutBtn: $('confirmLogoutBtn'),

    visualDropzone: $('visualDropzone'),
    visualFileInput: $('visualFileInput'),
    visualTypeBadge: $('visualTypeBadge'),
    visualMetaText: $('visualMetaText'),
    visualActions: $('visualActions'),
    replaceVisualBtn: $('replaceVisualBtn'),
    removeVisualBtn: $('removeVisualBtn'),

    previewWorkspace: $('previewWorkspace'),
    stickerFrame: $('stickerFrame'),
    previewImage: $('previewImage'),
    previewVideo: $('previewVideo'),
    cropGrid: $('cropGrid'),
    cropDragHint: $('cropDragHint'),
    speakerPreviewBadge: $('speakerPreviewBadge'),
    playPauseBtn: $('playPauseBtn'),
    playIcon: $('playIcon'),
    pauseIcon: $('pauseIcon'),
    loopBtn: $('loopBtn'),
    previewTimeReadout: $('previewTimeReadout'),
    audioModePill: $('audioModePill'),
    cropPresets: $('cropPresets'),

    stickerNameInput: $('stickerNameInput'),
    nameCharCount: $('nameCharCount'),
    wmPackPreview: $('wmPackPreview'),
    wmAuthorPreview: $('wmAuthorPreview'),

    audioDropzone: $('audioDropzone'),
    audioFileInput: $('audioFileInput'),
    audioFileCard: $('audioFileCard'),
    audioFileName: $('audioFileName'),
    audioFileMeta: $('audioFileMeta'),
    replaceAudioBtn: $('replaceAudioBtn'),
    removeAudioBtn: $('removeAudioBtn'),
    audioOverrideBanner: $('audioOverrideBanner'),
    previewAudio: $('previewAudio'),

    videoOptionsCard: $('videoOptionsCard'),
    fpsSelect: $('fpsSelect'),

    sendBtn: $('sendBtn'),
    sendSpinner: $('sendSpinner'),
    sendBtnText: $('sendBtnText'),
    sendHint: $('sendHint'),
    lastSentBox: $('lastSentBox'),

    timelineTip: $('timelineTip'),
    timelineSummary: $('timelineSummary'),
    timelineEmpty: $('timelineEmpty'),

    videoTrackBlock: $('videoTrackBlock'),
    videoRangeText: $('videoRangeText'),
    videoDurPill: $('videoDurPill'),
    videoRuler: $('videoRuler'),
    videoLane: $('videoLane'),
    videoFilmstrip: $('videoFilmstrip'),
    videoShadeLeft: $('videoShadeLeft'),
    videoShadeRight: $('videoShadeRight'),
    videoSelection: $('videoSelection'),
    videoHandleLeft: $('videoHandleLeft'),
    videoSelectionBody: $('videoSelectionBody'),
    videoSelectionBadge: $('videoSelectionBadge'),
    videoHandleRight: $('videoHandleRight'),
    videoPlayhead: $('videoPlayhead'),

    audioTrackBlock: $('audioTrackBlock'),
    audioRangeText: $('audioRangeText'),
    audioModeBadge: $('audioModeBadge'),
    audioRuler: $('audioRuler'),
    audioLane: $('audioLane'),
    audioWaveform: $('audioWaveform'),
    audioShadeLeft: $('audioShadeLeft'),
    audioShadeRight: $('audioShadeRight'),
    audioSelection: $('audioSelection'),
    audioHandleLeft: $('audioHandleLeft'),
    audioSelectionBody: $('audioSelectionBody'),
    audioSelectionBadge: $('audioSelectionBadge'),
    audioHandleRight: $('audioHandleRight'),
    audioRightGrip: $('audioRightGrip'),
    audioRightLock: $('audioRightLock'),
    audioPlayhead: $('audioPlayhead'),

    toastContainer: $('toastContainer')
  }

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val))
  }

  function fmtSec(sec) {
    const s = Number.isFinite(sec) ? Math.max(0, sec) : 0
    return `${s.toFixed(1)}d`
  }

  function fmtBytes(bytes) {
    if (!bytes) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div')
    toast.className = `toast ${type}`
    toast.textContent = message
    el.toastContainer.appendChild(toast)
    setTimeout(() => {
      toast.remove()
    }, 4200)
  }

  // ==================== WHATSAPP STATUS, CONNECT GATE & SSE ====================

  function applyStatusPayload(data) {
    const wasConnected = state.wa.connected

    if (data.maxDurationSeconds) {
      state.maxDurationSeconds = Number(data.maxDurationSeconds)
      el.maxDurationBadge.textContent = `Maks durasi: ${state.maxDurationSeconds}d`
    }
    if (data.maxInputSizeMb) {
      state.maxInputSizeMb = Number(data.maxInputSizeMb)
    }
    if (data.defaultAuthor) {
      state.defaultAuthor = data.defaultAuthor
      el.wmAuthorPreview.textContent = data.defaultAuthor
    }

    state.wa = {
      state: data.state || 'disconnected',
      connected: Boolean(data.connected),
      selfJidMasked: data.selfJidMasked || null,
      qrDataUrl: data.qrDataUrl || null,
      pairingCode: data.pairingCode || null,
      error: data.error || null
    }

    // Strict Connect Gate: hide editor completely until WhatsApp is linked!
    if (state.wa.connected) {
      el.connectGate.classList.add('hidden')
      el.studioApp.classList.remove('hidden')
      el.waStatusDot.className = 'status-dot connected'
      el.waStatusText.textContent = `WhatsApp Terhubung (${state.wa.selfJidMasked || 'Chat Pribadi'})`
      if (!wasConnected) {
        el.pairCodeBox.classList.add('hidden')
        el.pairCodeBox.textContent = ''
        el.pairPhoneInput.value = ''
      }
    } else {
      if (wasConnected) {
        stopPlayback()
      }
      el.studioApp.classList.add('hidden')
      el.connectGate.classList.remove('hidden')
      renderConnectGate()
    }

    updateSendButtonState()
  }

  function renderConnectGate() {
    el.connectStatusDot.className = `status-dot ${state.wa.state}`

    if (state.wa.qrDataUrl) {
      el.connectStatusText.textContent = 'Scan QR Code untuk Masuk'
      el.connectLoadingBox.classList.add('hidden')
      el.connectQrPanel.classList.remove('hidden')
      el.connectQrImg.src = state.wa.qrDataUrl
      if (state.wa.pairingCode) {
        el.pairCodeBox.textContent = state.wa.pairingCode
        el.pairCodeBox.classList.remove('hidden')
      } else {
        el.pairCodeBox.classList.add('hidden')
      }
    } else {
      el.connectQrPanel.classList.add('hidden')
      el.connectLoadingBox.classList.remove('hidden')

      if (state.wa.state === 'connecting') {
        el.connectStatusText.textContent = 'Menyambungkan ke WhatsApp...'
        el.connectLoadingMsg.textContent = state.wa.error || 'Menyiapkan sesi & QR Code WhatsApp...'
      } else if (state.wa.state === 'disconnected') {
        el.connectStatusText.textContent = 'Menyambung Ulang...'
        el.connectLoadingMsg.textContent = state.wa.error || 'Koneksi terputus, sedang mencoba menyambung ulang...'
      } else {
        el.connectStatusText.textContent = 'Belum Terhubung'
        el.connectLoadingMsg.textContent = state.wa.error || 'Menunggu koneksi WhatsApp...'
      }
    }
  }

  function initStatusStream() {
    fetch('/api/status')
      .then((r) => r.json())
      .then(applyStatusPayload)
      .catch(() => {})

    const es = new EventSource('/api/events')
    es.onmessage = (evt) => {
      try {
        applyStatusPayload(JSON.parse(evt.data))
      } catch {
        // ignore malformed event
      }
    }
    es.onerror = () => {
      // Browser auto-reconnects SSE
    }
  }

  // ==================== VISUAL LOADING (STRICTLY 1: IMAGE OR VIDEO) ====================

  function stopPlayback() {
    state.isPlaying = false
    if (state.rafId) {
      cancelAnimationFrame(state.rafId)
      state.rafId = null
    }
    try { el.previewVideo.pause() } catch {}
    try { el.previewAudio.pause() } catch {}
    el.playIcon.classList.remove('hidden')
    el.pauseIcon.classList.add('hidden')
    el.videoPlayhead.classList.add('hidden')
    el.audioPlayhead.classList.add('hidden')
  }

  function clearVisual() {
    stopPlayback()
    if (state.visualUrl) URL.revokeObjectURL(state.visualUrl)
    state.visualFile = null
    state.visualType = null
    state.visualUrl = null
    state.visualWidth = 0
    state.visualHeight = 0
    state.videoDuration = 0
    state.videoStart = 0
    state.videoEnd = 0

    el.previewImage.src = ''
    el.previewVideo.removeAttribute('src')
    el.previewVideo.load()
    el.visualFileInput.value = ''

    el.previewWorkspace.classList.add('hidden')
    el.visualDropzone.classList.remove('hidden')
    el.visualActions.classList.add('hidden')
    el.visualTypeBadge.classList.add('hidden')
    el.visualMetaText.classList.add('hidden')
    el.videoOptionsCard.classList.add('hidden')

    // If audio is still loaded, unlock right handle for standalone/image mode
    syncAudioWithVisualMode()
    renderTimelines()
    updateSendButtonState()
  }

  function loadVisualFile(file) {
    if (!file) return

    const mime = (file.type || '').toLowerCase()
    const nameLower = (file.name || '').toLowerCase()
    const isVideo = mime.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/.test(nameLower)
    const isImage = mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|bmp)$/.test(nameLower)

    if (!isVideo && !isImage) {
      showToast('Pilih file gambar atau video di area visual (file audio dimasukkan di kolom Audio Kustom).', 'error')
      return
    }

    if (file.size > state.maxInputSizeMb * 1024 * 1024) {
      showToast(`Ukuran file terlalu besar. Maksimal ${state.maxInputSizeMb} MB.`, 'error')
      return
    }

    stopPlayback()
    if (state.visualUrl) URL.revokeObjectURL(state.visualUrl)

    const objectUrl = URL.createObjectURL(file)
    state.visualFile = file
    state.visualUrl = objectUrl
    state.cropMode = 'center'
    state.cropX = 0.5
    state.cropY = 0.5

    if (isVideo) {
      state.visualType = 'video'
      el.previewImage.classList.add('hidden')
      el.previewVideo.classList.remove('hidden')
      el.previewVideo.src = objectUrl
      el.previewVideo.muted = Boolean(state.audioFile)

      el.previewVideo.onloadedmetadata = () => {
        const dur = Number.isFinite(el.previewVideo.duration) && el.previewVideo.duration > 0
          ? el.previewVideo.duration
          : state.maxDurationSeconds

        state.visualWidth = el.previewVideo.videoWidth || 512
        state.visualHeight = el.previewVideo.videoHeight || 512
        state.videoDuration = dur
        state.videoStart = 0
        state.videoEnd = Math.min(dur, state.maxDurationSeconds)

        el.previewVideo.currentTime = 0
        updateVisualHeaderUI()
        applyCropPreviewUI()
        syncAudioWithVisualMode()
        renderTimelines()
        renderVideoFilmstrip(objectUrl, dur)
        updateSendButtonState()
      }

      el.previewVideo.onerror = () => {
        showToast('Browser tidak bisa memutar preview video ini, namun tetap bisa dicoba kirim atau gunakan MP4/WebM.', 'error')
      }
    } else {
      state.visualType = 'image'
      state.videoDuration = 0
      state.videoStart = 0
      state.videoEnd = 0
      el.previewVideo.classList.add('hidden')
      el.previewVideo.removeAttribute('src')
      el.previewImage.classList.remove('hidden')
      el.previewImage.src = objectUrl

      el.previewImage.onload = () => {
        state.visualWidth = el.previewImage.naturalWidth || 512
        state.visualHeight = el.previewImage.naturalHeight || 512
        updateVisualHeaderUI()
        applyCropPreviewUI()
        syncAudioWithVisualMode()
        renderTimelines()
        updateSendButtonState()
      }
    }

    el.visualDropzone.classList.add('hidden')
    el.previewWorkspace.classList.remove('hidden')
    el.visualActions.classList.remove('hidden')
    updateCropPresetButtons()
  }

  function updateVisualHeaderUI() {
    if (!state.visualFile) return
    el.visualTypeBadge.classList.remove('hidden')
    el.visualMetaText.classList.remove('hidden')

    if (state.visualType === 'video') {
      el.visualTypeBadge.textContent = 'VIDEO'
      el.visualTypeBadge.classList.remove('image')
      el.visualMetaText.textContent = `${state.visualFile.name} • ${state.visualWidth}x${state.visualHeight} • ${fmtSec(state.videoDuration)}`
      el.videoOptionsCard.classList.remove('hidden')
    } else {
      el.visualTypeBadge.textContent = 'GAMBAR'
      el.visualTypeBadge.classList.add('image')
      el.visualMetaText.textContent = `${state.visualFile.name} • ${state.visualWidth}x${state.visualHeight}`
      el.videoOptionsCard.classList.add('hidden')
    }
    updateAudioIndicators()
  }

  // ==================== OPTIONAL CUSTOM AUDIO ====================

  function clearAudio() {
    stopPlayback()
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl)
    state.audioFile = null
    state.audioUrl = null
    state.audioDuration = 0
    state.audioStart = 0
    state.audioEnd = 0
    state.audioPeaks = null

    el.previewAudio.removeAttribute('src')
    el.previewAudio.load()
    el.audioFileInput.value = ''

    el.audioDropzone.classList.remove('hidden')
    el.audioFileCard.classList.add('hidden')
    el.removeAudioBtn.classList.add('hidden')
    el.audioOverrideBanner.classList.add('hidden')

    if (state.visualType === 'video') {
      el.previewVideo.muted = false
    }

    updateAudioIndicators()
    renderTimelines()
  }

  function loadAudioFile(file) {
    if (!file) return
    if (file.size > state.maxInputSizeMb * 1024 * 1024) {
      showToast(`Ukuran file audio terlalu besar. Maksimal ${state.maxInputSizeMb} MB.`, 'error')
      return
    }

    stopPlayback()
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl)

    const objectUrl = URL.createObjectURL(file)
    state.audioFile = file
    state.audioUrl = objectUrl
    el.previewAudio.src = objectUrl

    // Mute original video audio immediately when custom audio is loaded!
    if (state.visualType === 'video') {
      el.previewVideo.muted = true
    }

    el.audioDropzone.classList.add('hidden')
    el.audioFileCard.classList.remove('hidden')
    el.removeAudioBtn.classList.remove('hidden')
    el.audioFileName.textContent = file.name
    el.audioFileMeta.textContent = `Memuat audio (${fmtBytes(file.size)})...`

    el.previewAudio.onloadedmetadata = () => {
      const dur = Number.isFinite(el.previewAudio.duration) && el.previewAudio.duration > 0
        ? el.previewAudio.duration
        : state.maxDurationSeconds

      state.audioDuration = dur
      state.audioStart = 0
      syncAudioWithVisualMode(true)
      el.audioFileMeta.textContent = `Total ${fmtSec(dur)} • ${fmtBytes(file.size)}`
      updateAudioIndicators()
      renderTimelines()
      decodeAudioWaveform(file)
    }

    el.previewAudio.onerror = () => {
      showToast('Gagal memuat file audio. Pastikan format MP3, WAV, OGG, atau M4A valid.', 'error')
      clearAudio()
    }
  }

  function getVideoClipDuration() {
    if (state.visualType !== 'video') return 0
    return Math.max(MIN_CLIP_SECONDS, state.videoEnd - state.videoStart)
  }

  /**
   * Synchronizes the audio window with the current visual mode:
   * - If visual is VIDEO: audio duration is LOCKED to (videoEnd - videoStart), user drags ONLY start point!
   * - If visual is IMAGE (or none): user can drag both audioStart and audioEnd up to maxDurationSeconds.
   */
  function syncAudioWithVisualMode(resetRange = false) {
    if (!state.audioFile || state.audioDuration <= 0) {
      updateAudioIndicators()
      return
    }

    if (state.visualType === 'video') {
      const clipDur = getVideoClipDuration()
      const lockedDur = Math.min(clipDur, state.audioDuration)
      const maxStart = Math.max(0, state.audioDuration - lockedDur)
      state.audioStart = clamp(resetRange ? 0 : state.audioStart, 0, maxStart)
      state.audioEnd = Math.min(state.audioDuration, state.audioStart + lockedDur)
    } else {
      const maxDur = Math.min(state.maxDurationSeconds, state.audioDuration)
      if (resetRange || state.audioEnd <= state.audioStart) {
        state.audioStart = 0
        state.audioEnd = maxDur
      } else {
        state.audioStart = clamp(state.audioStart, 0, Math.max(0, state.audioDuration - MIN_CLIP_SECONDS))
        const desiredDur = clamp(state.audioEnd - state.audioStart, MIN_CLIP_SECONDS, maxDur)
        state.audioEnd = Math.min(state.audioDuration, state.audioStart + desiredDur)
      }
    }

    updateAudioIndicators()
  }

  function updateAudioIndicators() {
    const hasCustomAudio = Boolean(state.audioFile)
    const isVideo = state.visualType === 'video'

    el.audioOverrideBanner.classList.toggle('hidden', !(hasCustomAudio && isVideo))

    if (hasCustomAudio && isVideo) {
      el.audioModePill.textContent = 'Audio Kustom (Video di-mute)'
      el.audioModePill.className = 'audio-mode-pill custom'
      el.speakerPreviewBadge.classList.remove('hidden')
    } else if (hasCustomAudio && state.visualType === 'image') {
      el.audioModePill.textContent = 'Audio Kustom Aktif'
      el.audioModePill.className = 'audio-mode-pill custom'
      el.speakerPreviewBadge.classList.remove('hidden')
    } else if (isVideo) {
      el.audioModePill.textContent = 'Audio Asli Video'
      el.audioModePill.className = 'audio-mode-pill original'
      el.speakerPreviewBadge.classList.remove('hidden')
    } else {
      el.audioModePill.textContent = 'Tanpa suara (stiker gambar)'
      el.audioModePill.className = 'audio-mode-pill'
      el.speakerPreviewBadge.classList.add('hidden')
    }

    const canPlay = isVideo || (state.visualType === 'image' && hasCustomAudio)
    el.playPauseBtn.disabled = !canPlay
  }

  // ==================== CROP CONTROLS & LIVE DRAG ====================

  function setCropPreset(mode) {
    state.cropMode = mode
    if (mode === 'center') { state.cropX = 0.5; state.cropY = 0.5 }
    else if (mode === 'top') { state.cropX = 0.5; state.cropY = 0 }
    else if (mode === 'bottom') { state.cropX = 0.5; state.cropY = 1 }
    else if (mode === 'left') { state.cropX = 0; state.cropY = 0.5 }
    else if (mode === 'right') { state.cropX = 1; state.cropY = 0.5 }
    updateCropPresetButtons()
    applyCropPreviewUI()
  }

  function updateCropPresetButtons() {
    el.cropPresets.querySelectorAll('.chip').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.crop === state.cropMode)
    })
  }

  function applyCropPreviewUI() {
    const isNone = state.cropMode === 'none'
    const targets = [el.previewImage, el.previewVideo]
    for (const media of targets) {
      media.classList.toggle('fit-contain', isNone)
      media.style.objectPosition = `${(state.cropX * 100).toFixed(2)}% ${(state.cropY * 100).toFixed(2)}%`
    }
    el.stickerFrame.classList.toggle('draggable', !isNone && Boolean(state.visualFile))
    el.cropGrid.classList.toggle('hidden', isNone)
    el.cropDragHint.classList.toggle('hidden', isNone)
  }

  function initCropDrag() {
    let dragging = false
    let startClientX = 0
    let startClientY = 0
    let originCropX = 0.5
    let originCropY = 0.5

    el.stickerFrame.addEventListener('pointerdown', (e) => {
      if (!state.visualFile || state.cropMode === 'none') return
      dragging = true
      startClientX = e.clientX
      startClientY = e.clientY
      originCropX = state.cropX
      originCropY = state.cropY
      el.stickerFrame.classList.add('dragging')
      el.stickerFrame.setPointerCapture(e.pointerId)
    })

    el.stickerFrame.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const rect = el.stickerFrame.getBoundingClientRect()
      const dx = (e.clientX - startClientX) / Math.max(120, rect.width)
      const dy = (e.clientY - startClientY) / Math.max(120, rect.height)
      // Dragging image right reveals the left part (lower object-position %)
      state.cropX = clamp(originCropX - dx * 1.4, 0, 1)
      state.cropY = clamp(originCropY - dy * 1.4, 0, 1)
      state.cropMode = 'custom'
      updateCropPresetButtons()
      applyCropPreviewUI()
    })

    const endDrag = () => {
      if (!dragging) return
      dragging = false
      el.stickerFrame.classList.remove('dragging')
    }
    el.stickerFrame.addEventListener('pointerup', endDrag)
    el.stickerFrame.addEventListener('pointercancel', endDrag)
  }

  // ==================== FILMSTRIP & WAVEFORM RENDERING ====================

  async function renderVideoFilmstrip(url, duration) {
    const canvas = el.videoFilmstrip
    const ctx = canvas.getContext('2d')
    const width = Math.max(600, el.videoLane.clientWidth || 900)
    const height = 68
    canvas.width = width
    canvas.height = height

    ctx.fillStyle = '#111622'
    ctx.fillRect(0, 0, width, height)

    const tempVid = document.createElement('video')
    tempVid.muted = true
    tempVid.playsInline = true
    tempVid.preload = 'auto'
    tempVid.src = url

    await new Promise((resolve) => {
      tempVid.onloadeddata = resolve
      tempVid.onerror = resolve
    })

    if (!tempVid.videoWidth || !tempVid.videoHeight || duration <= 0) return

    const tileCount = Math.max(8, Math.min(18, Math.floor(width / 74)))
    const tileW = width / tileCount

    for (let i = 0; i < tileCount; i++) {
      // Abort if user replaced the video mid-render
      if (state.visualUrl !== url) return
      const t = Math.min(duration - 0.02, ((i + 0.5) / tileCount) * duration)
      await new Promise((resolve) => {
        const onSeeked = () => {
          tempVid.removeEventListener('seeked', onSeeked)
          resolve()
        }
        tempVid.addEventListener('seeked', onSeeked)
        try {
          tempVid.currentTime = Math.max(0, t)
        } catch {
          resolve()
        }
        setTimeout(resolve, 450)
      })

      try {
        const aspect = tempVid.videoWidth / tempVid.videoHeight
        const targetAspect = tileW / height
        let sx = 0, sy = 0, sw = tempVid.videoWidth, sh = tempVid.videoHeight
        if (aspect > targetAspect) {
          sw = tempVid.videoHeight * targetAspect
          sx = (tempVid.videoWidth - sw) / 2
        } else {
          sh = tempVid.videoWidth / targetAspect
          sy = (tempVid.videoHeight - sh) / 2
        }
        ctx.drawImage(tempVid, sx, sy, sw, sh, i * tileW, 0, tileW + 1, height)
      } catch {
        // ignore draw error
      }
    }
  }

  async function decodeAudioWaveform(file) {
    try {
      const arrayBuffer = await file.arrayBuffer()
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (!AudioCtx) throw new Error('No AudioContext')
      const audioCtx = new AudioCtx()
      const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0))
      const channelData = decoded.getChannelData(0)
      const bars = 160
      const blockSize = Math.max(1, Math.floor(channelData.length / bars))
      const peaks = new Float32Array(bars)
      let maxPeak = 0.01

      for (let i = 0; i < bars; i++) {
        let sum = 0
        const start = i * blockSize
        const step = Math.max(1, Math.floor(blockSize / 64))
        let count = 0
        for (let j = 0; j < blockSize && start + j < channelData.length; j += step) {
          sum += Math.abs(channelData[start + j])
          count++
        }
        peaks[i] = count > 0 ? sum / count : 0
        if (peaks[i] > maxPeak) maxPeak = peaks[i]
      }

      for (let i = 0; i < bars; i++) {
        peaks[i] = Math.min(1, peaks[i] / maxPeak)
      }

      state.audioPeaks = peaks
      audioCtx.close().catch(() => {})
    } catch {
      // Fallback smooth waveform pattern if browser can't decode codec
      const bars = 120
      const peaks = new Float32Array(bars)
      for (let i = 0; i < bars; i++) {
        peaks[i] = 0.25 + 0.55 * Math.abs(Math.sin(i * 0.35) * Math.cos(i * 0.13))
      }
      state.audioPeaks = peaks
    }
    drawWaveformCanvas()
  }

  function drawWaveformCanvas() {
    const canvas = el.audioWaveform
    const ctx = canvas.getContext('2d')
    const width = Math.max(600, el.audioLane.clientWidth || 900)
    const height = 62
    canvas.width = width
    canvas.height = height

    ctx.fillStyle = '#111320'
    ctx.fillRect(0, 0, width, height)

    const peaks = state.audioPeaks
    if (!peaks || peaks.length === 0) return

    const barW = width / peaks.length
    const midY = height / 2

    ctx.fillStyle = '#9b7bff'
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(3, peaks[i] * (height * 0.82))
      const x = i * barW + 1
      const w = Math.max(1.5, barW - 2)
      ctx.fillRect(x, midY - amp / 2, w, amp)
    }
  }

  // ==================== TIMELINE RENDERING & DRAGGING ====================

  function renderRuler(container, totalDuration) {
    container.innerHTML = ''
    if (!totalDuration || totalDuration <= 0) return
    const tickCount = Math.min(10, Math.max(4, Math.ceil(totalDuration / 2)))
    for (let i = 0; i <= tickCount; i++) {
      const ratio = i / tickCount
      const sec = ratio * totalDuration
      const tick = document.createElement('span')
      tick.className = `ruler-tick${i === 0 ? ' first' : i === tickCount ? ' last' : ''}`
      tick.style.left = `${ratio * 100}%`
      tick.textContent = `${sec.toFixed(1)}d`
      container.appendChild(tick)
    }
  }

  function renderTimelines() {
    const hasVideo = state.visualType === 'video' && state.videoDuration > 0
    const hasAudio = Boolean(state.audioFile) && state.audioDuration > 0

    el.timelineEmpty.classList.toggle('hidden', hasVideo || hasAudio)
    el.videoTrackBlock.classList.toggle('hidden', !hasVideo)
    el.audioTrackBlock.classList.toggle('hidden', !hasAudio)

    if (hasVideo) {
      const dur = state.videoDuration
      const leftPct = (state.videoStart / dur) * 100
      const rightPct = (state.videoEnd / dur) * 100
      const clipDur = state.videoEnd - state.videoStart

      el.videoShadeLeft.style.width = `${leftPct}%`
      el.videoShadeRight.style.width = `${Math.max(0, 100 - rightPct)}%`
      el.videoSelection.style.left = `${leftPct}%`
      el.videoSelection.style.width = `${Math.max(1, rightPct - leftPct)}%`

      el.videoRangeText.textContent = `${fmtSec(state.videoStart)} → ${fmtSec(state.videoEnd)}`
      el.videoDurPill.textContent = `Durasi: ${fmtSec(clipDur)} / maks ${state.maxDurationSeconds}d`
      el.videoSelectionBadge.textContent = fmtSec(clipDur)
      renderRuler(el.videoRuler, dur)
    }

    if (hasAudio) {
      const dur = state.audioDuration
      const leftPct = (state.audioStart / dur) * 100
      const rightPct = (state.audioEnd / dur) * 100
      const audioClipDur = Math.max(0, state.audioEnd - state.audioStart)

      el.audioShadeLeft.style.width = `${leftPct}%`
      el.audioShadeRight.style.width = `${Math.max(0, 100 - rightPct)}%`
      el.audioSelection.style.left = `${leftPct}%`
      el.audioSelection.style.width = `${Math.max(1, rightPct - leftPct)}%`

      el.audioRangeText.textContent = `${fmtSec(state.audioStart)} → ${fmtSec(state.audioEnd)}`
      el.audioSelectionBadge.textContent = `${fmtSec(state.audioStart)} → ${fmtSec(state.audioEnd)}`
      renderRuler(el.audioRuler, dur)
      drawWaveformCanvas()

      if (hasVideo) {
        const videoDur = getVideoClipDuration()
        el.audioModeBadge.textContent = `Geser awalan saja • Durasi otomatis ${fmtSec(audioClipDur)} (ikut video ${fmtSec(videoDur)})`
        el.audioHandleRight.classList.add('locked')
        el.audioHandleRight.title = 'Durasi audio terkunci mengikuti panjang potongan video'
        el.audioRightGrip.classList.add('hidden')
        el.audioRightLock.classList.remove('hidden')
      } else {
        el.audioModeBadge.textContent = `Durasi audio: ${fmtSec(audioClipDur)} / maks ${state.maxDurationSeconds}d`
        el.audioHandleRight.classList.remove('locked')
        el.audioHandleRight.title = 'Geser titik akhir audio'
        el.audioRightGrip.classList.remove('hidden')
        el.audioRightLock.classList.add('hidden')
      }
    }

    // Update top tip & summary
    if (hasVideo && hasAudio) {
      const vDur = getVideoClipDuration()
      el.timelineTip.textContent = 'Geser kiri/kanan pada Video untuk potong durasi. Pada Audio, geser awalan saja — akhirannya otomatis mengikuti durasi video.'
      el.timelineSummary.textContent = `Video ${fmtSec(state.videoStart)}→${fmtSec(state.videoEnd)} (${fmtSec(vDur)}) • Audio ${fmtSec(state.audioStart)}→${fmtSec(state.audioEnd)}`
      el.previewTimeReadout.textContent = `${fmtSec(0)} / ${fmtSec(vDur)}`
    } else if (hasVideo) {
      const vDur = getVideoClipDuration()
      el.timelineTip.textContent = `Geser handle kiri/kanan pada track Video (maksimal ${state.maxDurationSeconds} detik).`
      el.timelineSummary.textContent = `Video ${fmtSec(state.videoStart)}→${fmtSec(state.videoEnd)} (${fmtSec(vDur)})`
      el.previewTimeReadout.textContent = `${fmtSec(0)} / ${fmtSec(vDur)}`
    } else if (hasAudio) {
      const aDur = state.audioEnd - state.audioStart
      el.timelineTip.textContent = `Geser handle Audio untuk memilih suara stiker gambar (maksimal ${state.maxDurationSeconds} detik).`
      el.timelineSummary.textContent = `Audio ${fmtSec(state.audioStart)}→${fmtSec(state.audioEnd)} (${fmtSec(aDur)})`
      el.previewTimeReadout.textContent = `${fmtSec(0)} / ${fmtSec(aDur)}`
    } else {
      el.timelineTip.textContent = 'Pilih video atau audio untuk mulai menggeser potongan frame.'
      el.timelineSummary.textContent = ''
      el.previewTimeReadout.textContent = '0.0d / 0.0d'
    }
  }

  function initTimelineDragging() {
    // 1. Video Track Dragging (left handle, right handle, or middle body move)
    function attachVideoDrag(targetEl, mode) {
      targetEl.addEventListener('pointerdown', (e) => {
        if (state.visualType !== 'video' || state.videoDuration <= 0) return
        e.preventDefault()
        e.stopPropagation()
        stopPlayback()

        const laneRect = el.videoLane.getBoundingClientRect()
        const startX = e.clientX
        const origStart = state.videoStart
        const origEnd = state.videoEnd
        const total = state.videoDuration
        const maxDur = Math.min(state.maxDurationSeconds, total)

        targetEl.setPointerCapture(e.pointerId)

        const onMove = (ev) => {
          const deltaSec = ((ev.clientX - startX) / laneRect.width) * total

          if (mode === 'left') {
            let nextStart = clamp(origStart + deltaSec, 0, origEnd - MIN_CLIP_SECONDS)
            let nextEnd = origEnd
            if (nextEnd - nextStart > maxDur) {
              nextEnd = nextStart + maxDur
            }
            state.videoStart = nextStart
            state.videoEnd = nextEnd
            el.previewVideo.currentTime = state.videoStart
          } else if (mode === 'right') {
            let nextEnd = clamp(origEnd + deltaSec, origStart + MIN_CLIP_SECONDS, total)
            let nextStart = origStart
            if (nextEnd - nextStart > maxDur) {
              nextStart = nextEnd - maxDur
            }
            state.videoStart = nextStart
            state.videoEnd = nextEnd
            el.previewVideo.currentTime = Math.max(state.videoStart, state.videoEnd - 0.05)
          } else if (mode === 'move') {
            const len = origEnd - origStart
            const nextStart = clamp(origStart + deltaSec, 0, Math.max(0, total - len))
            state.videoStart = nextStart
            state.videoEnd = nextStart + len
            el.previewVideo.currentTime = state.videoStart
          }

          // Live sync audio selection width whenever video duration changes!
          syncAudioWithVisualMode(false)
          renderTimelines()
        }

        const onUp = () => {
          targetEl.removeEventListener('pointermove', onMove)
          targetEl.removeEventListener('pointerup', onUp)
          targetEl.removeEventListener('pointercancel', onUp)
          el.previewVideo.currentTime = state.videoStart
        }

        targetEl.addEventListener('pointermove', onMove)
        targetEl.addEventListener('pointerup', onUp)
        targetEl.addEventListener('pointercancel', onUp)
      })
    }

    attachVideoDrag(el.videoHandleLeft, 'left')
    attachVideoDrag(el.videoHandleRight, 'right')
    attachVideoDrag(el.videoSelectionBody, 'move')

    // 2. Audio Track Dragging
    // When visual is VIDEO: left handle AND body both drag ONLY the start offset (locked duration = videoEnd - videoStart).
    // When visual is IMAGE: left handle trims start, right handle trims end (up to maxDurationSeconds), body slides window.
    function attachAudioDrag(targetEl, mode) {
      targetEl.addEventListener('pointerdown', (e) => {
        if (!state.audioFile || state.audioDuration <= 0) return
        const isSyncedToVideo = state.visualType === 'video'
        if (mode === 'right' && isSyncedToVideo) {
          showToast('Durasi audio otomatis mengikuti potongan video. Geser awalan audio saja!', 'info')
          return
        }

        e.preventDefault()
        e.stopPropagation()
        stopPlayback()

        const laneRect = el.audioLane.getBoundingClientRect()
        const startX = e.clientX
        const origStart = state.audioStart
        const origEnd = state.audioEnd
        const total = state.audioDuration
        const maxDur = Math.min(state.maxDurationSeconds, total)

        targetEl.setPointerCapture(e.pointerId)

        const onMove = (ev) => {
          const deltaSec = ((ev.clientX - startX) / laneRect.width) * total

          if (isSyncedToVideo) {
            // Dragging start-only: window width is strictly locked to video clip duration!
            const lockedDur = Math.min(getVideoClipDuration(), total)
            const maxStart = Math.max(0, total - lockedDur)
            const nextStart = clamp(origStart + deltaSec, 0, maxStart)
            state.audioStart = nextStart
            state.audioEnd = Math.min(total, nextStart + lockedDur)
          } else if (mode === 'left') {
            let nextStart = clamp(origStart + deltaSec, 0, origEnd - MIN_CLIP_SECONDS)
            let nextEnd = origEnd
            if (nextEnd - nextStart > maxDur) {
              nextEnd = nextStart + maxDur
            }
            state.audioStart = nextStart
            state.audioEnd = nextEnd
          } else if (mode === 'right') {
            let nextEnd = clamp(origEnd + deltaSec, origStart + MIN_CLIP_SECONDS, total)
            let nextStart = origStart
            if (nextEnd - nextStart > maxDur) {
              nextStart = nextEnd - maxDur
            }
            state.audioStart = nextStart
            state.audioEnd = nextEnd
          } else if (mode === 'move') {
            const len = origEnd - origStart
            const nextStart = clamp(origStart + deltaSec, 0, Math.max(0, total - len))
            state.audioStart = nextStart
            state.audioEnd = nextStart + len
          }

          renderTimelines()
        }

        const onUp = () => {
          targetEl.removeEventListener('pointermove', onMove)
          targetEl.removeEventListener('pointerup', onUp)
          targetEl.removeEventListener('pointercancel', onUp)
        }

        targetEl.addEventListener('pointermove', onMove)
        targetEl.addEventListener('pointerup', onUp)
        targetEl.addEventListener('pointercancel', onUp)
      })
    }

    attachAudioDrag(el.audioHandleLeft, 'left')
    attachAudioDrag(el.audioSelectionBody, 'move')
    attachAudioDrag(el.audioHandleRight, 'right')

    // Click anywhere on audio lane when synced to video to jump audioStart directly!
    el.audioLane.addEventListener('pointerdown', (e) => {
      if (!state.audioFile || state.audioDuration <= 0) return
      if (e.target !== el.audioLane && e.target !== el.audioWaveform) return
      stopPlayback()
      const rect = el.audioLane.getBoundingClientRect()
      const clickedSec = clamp(((e.clientX - rect.left) / rect.width) * state.audioDuration, 0, state.audioDuration)
      const currentLen = state.visualType === 'video'
        ? Math.min(getVideoClipDuration(), state.audioDuration)
        : Math.max(MIN_CLIP_SECONDS, state.audioEnd - state.audioStart)
      const maxStart = Math.max(0, state.audioDuration - currentLen)
      state.audioStart = clamp(clickedSec, 0, maxStart)
      state.audioEnd = Math.min(state.audioDuration, state.audioStart + currentLen)
      renderTimelines()
    })
  }

  // ==================== SYNCHRONIZED PLAYBACK ====================

  async function startPlayback() {
    const isVideo = state.visualType === 'video'
    const hasCustomAudio = Boolean(state.audioFile)
    if (!isVideo && !hasCustomAudio) return

    stopPlayback()
    state.isPlaying = true
    el.playIcon.classList.add('hidden')
    el.pauseIcon.classList.remove('hidden')

    const startSyncCycle = async () => {
      if (!state.isPlaying) return

      if (isVideo) {
        el.previewVideo.muted = hasCustomAudio // Override: mute original video when custom audio is active!
        el.previewVideo.currentTime = state.videoStart
      }
      if (hasCustomAudio) {
        el.previewAudio.currentTime = state.audioStart
      }

      const playTasks = []
      if (isVideo) playTasks.push(el.previewVideo.play().catch(() => {}))
      if (hasCustomAudio) playTasks.push(el.previewAudio.play().catch(() => {}))
      await Promise.all(playTasks)
    }

    await startSyncCycle()

    const tick = () => {
      if (!state.isPlaying) return

      if (isVideo) {
        const curV = el.previewVideo.currentTime
        const clipDur = getVideoClipDuration()
        const elapsed = clamp(curV - state.videoStart, 0, clipDur)

        el.previewTimeReadout.textContent = `${fmtSec(elapsed)} / ${fmtSec(clipDur)}`
        el.videoPlayhead.classList.remove('hidden')
        el.videoPlayhead.style.left = `${(curV / state.videoDuration) * 100}%`

        if (hasCustomAudio && state.audioDuration > 0) {
          const expectedAudioT = Math.min(state.audioDuration, state.audioStart + elapsed)
          // Stop custom audio if it reaches end of file before video ends
          if (expectedAudioT >= state.audioEnd - 0.02 && !el.previewAudio.paused) {
            el.previewAudio.pause()
          }
          el.audioPlayhead.classList.remove('hidden')
          el.audioPlayhead.style.left = `${(expectedAudioT / state.audioDuration) * 100}%`
        }

        if (curV >= state.videoEnd - 0.03 || el.previewVideo.ended) {
          if (state.loop) {
            startSyncCycle()
          } else {
            stopPlayback()
            el.previewVideo.currentTime = state.videoStart
            return
          }
        }
      } else if (hasCustomAudio) {
        const curA = el.previewAudio.currentTime
        const clipDur = Math.max(MIN_CLIP_SECONDS, state.audioEnd - state.audioStart)
        const elapsed = clamp(curA - state.audioStart, 0, clipDur)

        el.previewTimeReadout.textContent = `${fmtSec(elapsed)} / ${fmtSec(clipDur)}`
        el.audioPlayhead.classList.remove('hidden')
        el.audioPlayhead.style.left = `${(curA / state.audioDuration) * 100}%`

        if (curA >= state.audioEnd - 0.03 || el.previewAudio.ended) {
          if (state.loop) {
            startSyncCycle()
          } else {
            stopPlayback()
            return
          }
        }
      }

      state.rafId = requestAnimationFrame(tick)
    }

    state.rafId = requestAnimationFrame(tick)
  }

  function togglePlayback() {
    if (state.isPlaying) stopPlayback()
    else startPlayback()
  }

  // ==================== VALIDATION & SEND TO PERSONAL CHAT ====================

  function updateSendButtonState() {
    const hasVisual = Boolean(state.visualFile)
    const trimmedName = state.stickerName.trim()
    const hasName = trimmedName.length > 0
    const waReady = state.wa.connected

    el.nameCharCount.textContent = `${state.stickerName.length}/80`
    if (hasName) {
      el.wmPackPreview.textContent = trimmedName
      el.wmPackPreview.classList.remove('placeholder')
    } else {
      el.wmPackPreview.textContent = 'Nama stiker belum diisi'
      el.wmPackPreview.classList.add('placeholder')
    }

    const canSend = hasVisual && hasName && waReady && !state.sending
    el.sendBtn.disabled = !canSend

    el.sendHint.classList.remove('ready')
    if (state.sending) {
      el.sendHint.textContent = 'Sedang mengonversi & mengirim stiker ke chat pribadi...'
    } else if (!hasVisual) {
      el.sendHint.textContent = 'Pilih 1 gambar atau 1 video terlebih dahulu.'
    } else if (!hasName) {
      el.sendHint.textContent = 'Isi Nama Stiker terlebih dahulu sebelum mengirim.'
    } else if (!waReady) {
      el.sendHint.textContent = 'WhatsApp belum terhubung. Klik tombol status WhatsApp di kanan atas.'
    } else {
      el.sendHint.textContent = `Siap dikirim ke chat pribadi (${state.wa.selfJidMasked || 'WhatsApp Anda'}) • Author: ${state.defaultAuthor}`
      el.sendHint.classList.add('ready')
    }
  }

  async function sendSticker() {
    if (state.sending) return
    const trimmedName = state.stickerName.trim()
    if (!state.visualFile) {
      showToast('Pilih gambar atau video terlebih dahulu.', 'error')
      return
    }
    if (!trimmedName) {
      el.stickerNameInput.classList.add('invalid')
      el.stickerNameInput.focus()
      showToast('Nama stiker wajib diisi sebelum mengirim.', 'error')
      return
    }
    if (!state.wa.connected) {
      showToast('WhatsApp belum terhubung. Scan QR terlebih dahulu.', 'error')
      return
    }

    stopPlayback()
    state.sending = true
    el.sendSpinner.classList.remove('hidden')
    el.sendBtnText.textContent = 'Memproses & Mengirim...'
    updateSendButtonState()

    try {
      const formData = new FormData()
      formData.append('stickerName', trimmedName)
      formData.append('visual', state.visualFile, state.visualFile.name)
      formData.append('cropMode', state.cropMode)
      if (state.cropMode !== 'none') {
        formData.append('cropX', state.cropX.toFixed(4))
        formData.append('cropY', state.cropY.toFixed(4))
      }

      if (state.visualType === 'video') {
        formData.append('visualStart', state.videoStart.toFixed(3))
        formData.append('visualEnd', state.videoEnd.toFixed(3))
        formData.append('fps', String(state.fps))
      }

      if (state.audioFile) {
        formData.append('audio', state.audioFile, state.audioFile.name)
        formData.append('audioStart', state.audioStart.toFixed(3))
        if (state.visualType !== 'video') {
          formData.append('audioEnd', state.audioEnd.toFixed(3))
        }
      }

      const resp = await fetch('/api/send-sticker', {
        method: 'POST',
        body: formData
      })
      const result = await resp.json()

      if (!resp.ok || !result.ok) {
        throw new Error(result.error || 'Gagal mengirim stiker.')
      }

      const kindText = result.hasAudio
        ? result.isAnimated ? 'Stiker Video Bersuara' : 'Stiker Gambar Bersuara'
        : result.isAnimated ? 'Stiker Video (Tanpa Suara)' : 'Stiker Gambar'

      const audioNote = result.audioSource === 'custom'
        ? 'Audio kustom'
        : result.audioSource === 'original'
          ? 'Audio asli video'
          : 'Tanpa audio'

      el.lastSentBox.innerHTML =
        `<strong>Terkirim ke Chat Pribadi!</strong><br/>` +
        `${kindText} • <em>${escapeHtml(result.stickerName)}</em> (${escapeHtml(result.author)})<br/>` +
        `${audioNote} • ${fmtBytes(result.stickerBytes)}` +
        (result.audioBytes ? ` + ${fmtBytes(result.audioBytes)}` : '')
      el.lastSentBox.classList.remove('hidden')

      showToast(`Berhasil! "${result.stickerName}" terkirim ke chat pribadi WhatsApp.`, 'success')
    } catch (err) {
      showToast(err.message || 'Gagal mengirim stiker.', 'error')
    } finally {
      state.sending = false
      el.sendSpinner.classList.add('hidden')
      el.sendBtnText.textContent = 'Kirim ke Chat Pribadi'
      updateSendButtonState()
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // ==================== LOGOUT MODAL & EVENTS ====================

  function openLogoutModal() {
    el.logoutModal.classList.remove('hidden')
  }

  function closeLogoutModal() {
    el.logoutModal.classList.add('hidden')
  }

  async function performLogout() {
    el.confirmLogoutBtn.disabled = true
    el.confirmLogoutBtn.textContent = 'Memutuskan...'
    try {
      stopPlayback()
      const resp = await fetch('/api/logout', { method: 'POST' })
      const data = await resp.json()
      if (!resp.ok || !data.ok) {
        throw new Error(data.error || 'Gagal memutuskan koneksi WhatsApp.')
      }
      clearVisual()
      clearAudio()
      el.lastSentBox.classList.add('hidden')
      closeLogoutModal()
      showToast('WhatsApp berhasil diputuskan. Scan QR baru untuk masuk kembali.', 'success')
    } catch (err) {
      showToast(err.message || 'Gagal logout.', 'error')
    } finally {
      el.confirmLogoutBtn.disabled = false
      el.confirmLogoutBtn.textContent = 'Ya, Putuskan & Logout'
    }
  }

  function bindDropzone(zoneEl, inputEl, onFile) {
    zoneEl.addEventListener('click', () => inputEl.click())
    zoneEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        inputEl.click()
      }
    })
    zoneEl.addEventListener('dragover', (e) => {
      e.preventDefault()
      zoneEl.classList.add('drag-over')
    })
    zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('drag-over'))
    zoneEl.addEventListener('drop', (e) => {
      e.preventDefault()
      zoneEl.classList.remove('drag-over')
      const file = e.dataTransfer?.files?.[0]
      if (file) onFile(file)
    })
  }

  function initEvents() {
    bindDropzone(el.visualDropzone, el.visualFileInput, loadVisualFile)
    bindDropzone(el.audioDropzone, el.audioFileInput, loadAudioFile)

    el.visualFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0]
      if (file) loadVisualFile(file)
    })
    el.replaceVisualBtn.addEventListener('click', () => el.visualFileInput.click())
    el.removeVisualBtn.addEventListener('click', clearVisual)

    el.audioFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0]
      if (file) loadAudioFile(file)
    })
    el.replaceAudioBtn.addEventListener('click', () => el.audioFileInput.click())
    el.removeAudioBtn.addEventListener('click', clearAudio)

    el.cropPresets.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip')
      if (!btn) return
      setCropPreset(btn.dataset.crop)
    })

    el.playPauseBtn.addEventListener('click', togglePlayback)
    el.loopBtn.addEventListener('click', () => {
      state.loop = !state.loop
      el.loopBtn.classList.toggle('active', state.loop)
    })

    el.stickerNameInput.addEventListener('input', (e) => {
      state.stickerName = e.target.value
      el.stickerNameInput.classList.remove('invalid')
      updateSendButtonState()
    })

    el.fpsSelect.addEventListener('change', (e) => {
      state.fps = Number(e.target.value) || 12
    })

    el.sendBtn.addEventListener('click', sendSticker)

    el.logoutBtn.addEventListener('click', openLogoutModal)
    el.closeLogoutModalBtn.addEventListener('click', closeLogoutModal)
    el.cancelLogoutBtn.addEventListener('click', closeLogoutModal)
    el.confirmLogoutBtn.addEventListener('click', performLogout)
    el.logoutModal.addEventListener('click', (e) => {
      if (e.target === el.logoutModal) closeLogoutModal()
    })

    el.pairForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const phone = el.pairPhoneInput.value.trim()
      if (!phone) {
        showToast('Masukkan nomor WhatsApp terlebih dahulu (contoh: 6281234567890).', 'error')
        return
      }
      try {
        const resp = await fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone })
        })
        const data = await resp.json()
        if (!resp.ok || !data.ok) throw new Error(data.error || 'Gagal meminta kode pairing.')
        el.pairCodeBox.textContent = data.pairingCode
        el.pairCodeBox.classList.remove('hidden')
        showToast(`Kode pairing dibuat: ${data.pairingCode}`, 'success')
      } catch (err) {
        showToast(err.message, 'error')
      }
    })

    // Spacebar toggles playback when not typing in an input
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        if (!el.playPauseBtn.disabled) {
          e.preventDefault()
          togglePlayback()
        }
      }
    })

    window.addEventListener('resize', () => {
      if (state.audioPeaks) drawWaveformCanvas()
    })
  }

  initCropDrag()
  initTimelineDragging()
  initEvents()
  initStatusStream()
  updateSendButtonState()
})()
