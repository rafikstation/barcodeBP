/**
 * ScanX — Barcode Scanner
 * ────────────────────────
 * Supports: Aztec, PDF417 (including airline boarding passes)
 * Library : @zxing/browser (loaded via CDN)
 * Author  : ScanX  |  License: MIT
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   1. DOM REFERENCES
═══════════════════════════════════════════════════════════════ */
const videoEl       = document.getElementById('videoElement');
const loadingOvl    = document.getElementById('loadingOverlay');
const scanFlash     = document.getElementById('scanFlash');
const scanBeam      = document.getElementById('scanBeam');
const cameraBadge   = document.getElementById('cameraBadge');
const cameraPanel   = document.getElementById('cameraPanel');

const btnStart      = document.getElementById('btnStart');
const btnStop       = document.getElementById('btnStop');
const btnSwitch     = document.getElementById('btnSwitch');
const btnCopy       = document.getElementById('btnCopy');
const btnClear      = document.getElementById('btnClear');
const btnExport     = document.getElementById('btnExport');

const barcodeTypeEl = document.getElementById('barcodeType');
const scanTimeEl    = document.getElementById('scanTime');
const resultTextEl  = document.getElementById('resultText');
const boardingCard  = document.getElementById('boardingCard');
const boardingGrid  = document.getElementById('boardingGrid');

const historyBody   = document.getElementById('historyBody');
const emptyRow      = document.getElementById('emptyRow');
const historyCount  = document.getElementById('historyCount');

// ── Upload / Tab elements ──
const tabCamera         = document.getElementById('tabCamera');
const tabUpload         = document.getElementById('tabUpload');
const cameraControls    = document.getElementById('cameraControls');
const uploadPanel       = document.getElementById('uploadPanel');
const dropZone          = document.getElementById('dropZone');
const fileInput         = document.getElementById('fileInput');
const uploadPreviewRow  = document.getElementById('uploadPreviewRow');
const uploadedImg       = document.getElementById('uploadedImg');
const uploadScanningOvl = document.getElementById('uploadScanningOverlay');
const uploadStatus      = document.getElementById('uploadStatus');
const btnRetryUpload    = document.getElementById('btnRetryUpload');

/* ═══════════════════════════════════════════════════════════════
   2. APPLICATION STATE
═══════════════════════════════════════════════════════════════ */
let codeReader   = null;   // ZXing reader instance
let isScanning   = false;  // Whether the scanner is active
let lastScan     = '';     // Last decoded string (dedup guard)
let scanHistory  = [];     // Array of { ts, type, value } objects
let cameras      = [];     // Available video input devices
let cameraIndex  = 0;      // Currently active camera index

/* ═══════════════════════════════════════════════════════════════
   3. BEEP SOUND — Generate a short sine-wave beep via Web Audio
═══════════════════════════════════════════════════════════════ */
/**
 * Plays a short 880 Hz sine-wave beep using the Web Audio API.
 * Falls back silently if AudioContext is not available.
 */
function playBeep() {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type      = 'sine';
    osc.frequency.value = 880;          // A5 note
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.18);

    // Clean up after playback
    osc.onended = () => ctx.close();
  } catch (_) { /* AudioContext not supported */ }
}

/* ═══════════════════════════════════════════════════════════════
   4. CAMERA UTILITIES
═══════════════════════════════════════════════════════════════ */
/**
 * Enumerate available video input devices and store them in `cameras`.
 * Returns the list so callers can use it immediately.
 */
async function enumerateCameras() {
  try {
    // Trigger a permission prompt first so labels are populated
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras = devices.filter(d => d.kind === 'videoinput');
    return cameras;
  } catch (err) {
    console.warn('Could not enumerate cameras:', err);
    return [];
  }
}

/**
 * Determine a friendly label for the camera badge.
 * If a device label contains "back" or "rear" it is labelled accordingly.
 */
function cameraLabel(device) {
  if (!device) return 'Camera';
  const lbl = (device.label || '').toLowerCase();
  if (lbl.includes('back') || lbl.includes('rear') || lbl.includes('environment'))
    return 'Rear Camera';
  if (lbl.includes('front') || lbl.includes('user') || lbl.includes('face'))
    return 'Front Camera';
  return `Camera ${cameraIndex + 1}`;
}

/* ═══════════════════════════════════════════════════════════════
   5. SCANNER — START / STOP
═══════════════════════════════════════════════════════════════ */
/**
 * Initialise (or re-initialise) the ZXing reader and begin decoding.
 * Targets Aztec and PDF417 formats only for maximum performance.
 */
async function startScanner() {
  if (isScanning) return;

  // Show loading state
  loadingOvl.classList.remove('hidden');
  btnStart.disabled = true;

  try {
    // Ensure ZXing is loaded
    if (typeof ZXingBrowser === 'undefined') {
      throw new Error('ZXing library not loaded. Check your CDN URL.');
    }

    // Build a hints map restricting formats to Aztec + PDF417
    const { BrowserMultiFormatReader, BarcodeFormat, DecodeHintType } = ZXingBrowser;

    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.AZTEC,
      BarcodeFormat.PDF_417,
    ]);
    // Try harder — more accurate at cost of speed
    hints.set(DecodeHintType.TRY_HARDER, true);

    // Create fresh reader instance
    codeReader = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 150,   // ms between frames
      delayBetweenScanSuccess:  1500,  // ms cooldown after success
    });

    // Enumerate cameras (only needed once)
    if (cameras.length === 0) await enumerateCameras();

    // Choose the device ID (cycle through available cameras)
    const deviceId = cameras[cameraIndex]?.deviceId ?? undefined;

    // Start continuous decode — ZXing handles the stream internally
    await codeReader.decodeFromVideoDevice(
      deviceId,
      videoEl,
      handleScanResult
    );

    isScanning = true;
    cameraPanel.classList.add('active');
    loadingOvl.classList.add('hidden');

    // Update UI state
    btnStop.disabled    = false;
    btnSwitch.disabled  = cameras.length < 2;
    btnStart.disabled   = true;

    cameraBadge.textContent = cameraLabel(cameras[cameraIndex]);

  } catch (err) {
    handleCameraError(err);
  }
}

/**
 * Stop the scanner and reset video stream.
 */
function stopScanner() {
  if (codeReader) {
    codeReader.reset();
    codeReader = null;
  }
  if (videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop());
    videoEl.srcObject = null;
  }
  isScanning = false;
  cameraPanel.classList.remove('active');
  loadingOvl.classList.add('hidden');

  btnStart.disabled   = false;
  btnStop.disabled    = true;
  btnSwitch.disabled  = true;
}

/**
 * Switch to the next available camera (toggles front ↔ back on mobile).
 */
async function switchCamera() {
  if (cameras.length < 2) return;
  cameraIndex = (cameraIndex + 1) % cameras.length;

  // Restart with the new camera
  stopScanner();
  await startScanner();
}

/* ═══════════════════════════════════════════════════════════════
   6. SCAN RESULT HANDLER
═══════════════════════════════════════════════════════════════ */
/**
 * Called by ZXing on every frame. Receives either a Result or an error.
 * @param {import('@zxing/library').Result|null} result
 * @param {Error|null} err
 */
function handleScanResult(result, err) {
  if (err) {
    // NotFoundException fires every frame when no barcode is in view — ignore it
    if (err.name === 'NotFoundException') return;
    console.warn('Scan error:', err);
    return;
  }

  if (!result) return;

  const text     = result.getText();
  const format   = result.getBarcodeFormat(); // numeric enum
  const typeName = formatName(format);

  // ── Duplicate guard (ignore re-scans of same content within ~2 s) ──
  if (text === lastScan) return;
  lastScan = text;

  // Reset dedup after 2 seconds so same code can be rescanned
  setTimeout(() => { lastScan = ''; }, 2000);

  // ── Feedback: beep + flash ──
  playBeep();
  triggerFlash();

  // ── Update result panel ──
  const ts = new Date();
  barcodeTypeEl.textContent = typeName;
  scanTimeEl.textContent    = formatTimestamp(ts);
  resultTextEl.value        = text;
  btnCopy.disabled          = false;

  // ── Boarding pass decode attempt ──
  const boardingData = decodeBoardingPass(text, typeName);
  if (boardingData) {
    renderBoardingPass(boardingData);
  } else {
    boardingCard.hidden = true;
  }

  // ── Append to history ──
  const entry = { ts, type: typeName, value: text, isBoarding: !!boardingData };
  scanHistory.unshift(entry); // newest first
  prependHistoryRow(entry, scanHistory.length);
  updateHistoryCount();

  btnClear.disabled  = false;
  btnExport.disabled = false;
}

/* ═══════════════════════════════════════════════════════════════
   7. BARCODE FORMAT HELPERS
═══════════════════════════════════════════════════════════════ */
/**
 * Convert ZXing's numeric BarcodeFormat enum to a readable string.
 * @param {number} format
 * @returns {string}
 */
function formatName(format) {
  // ZXing BarcodeFormat enum values
  const map = {
    0:  'AZTEC',
    1:  'CODABAR',
    2:  'CODE_39',
    3:  'CODE_93',
    4:  'CODE_128',
    5:  'DATA_MATRIX',
    6:  'EAN_8',
    7:  'EAN_13',
    8:  'ITF',
    9:  'MAXICODE',
    10: 'PDF_417',
    11: 'QR_CODE',
    12: 'RSS_14',
    13: 'RSS_EXPANDED',
    14: 'UPC_A',
    15: 'UPC_E',
    16: 'UPC_EAN_EXTENSION',
  };
  return map[format] ?? `FORMAT_${format}`;
}

/* ═══════════════════════════════════════════════════════════════
   8. BOARDING PASS DECODER (IATA BCBP)
   IATA Resolution 792 — Bar Coded Boarding Pass
═══════════════════════════════════════════════════════════════ */
/**
 * Attempt to parse an IATA BCBP string (typically encoded in PDF417 / Aztec).
 * Returns a structured object or null if the data doesn't match.
 *
 * BCBP format (mandatory fields):
 *   Pos   Len  Field
 *   0      1   Format code ("M")
 *   1      1   Number of legs
 *   2     20   Passenger name (LAST/FIRST)
 *   22     1   Electronic ticket indicator
 *   23     7   Operating carrier PNR code
 *   30     3   From city (IATA airport code)
 *   33     3   To city (IATA airport code)
 *   36     3   Operating carrier designator
 *   39     5   Flight number
 *   44     3   Date of flight (Julian)
 *   47     1   Compartment code
 *   48     7   Seat number
 *   55     5   Check-in sequence number
 *   60     1   Passenger status
 *
 * @param {string} text  — Raw decoded barcode string
 * @param {string} type  — Detected barcode format name
 * @returns {Object|null}
 */
function decodeBoardingPass(text, type) {
  // Only attempt on PDF417 or Aztec
  if (type !== 'PDF_417' && type !== 'AZTEC') return null;

  // Must start with "M" (format code for BCBP)
  if (!text || text[0] !== 'M') return null;
  // Minimum mandatory segment length is 60 characters
  if (text.length < 60) return null;

  try {
    const legs      = parseInt(text[1], 10) || 1;
    const name      = text.substring(2, 22).trim();
    const eTicket   = text[22] === 'E' ? 'Electronic' : 'Paper';
    const pnr       = text.substring(23, 30).trim();
    const from      = text.substring(30, 33).trim();
    const to        = text.substring(33, 36).trim();
    const carrier   = text.substring(36, 39).trim();
    const flightRaw = text.substring(39, 44).trim();
    const julianDay = text.substring(44, 47).trim();
    const seat      = text.substring(48, 55).trim();
    const seqRaw    = text.substring(55, 60).trim();

    // Validate: PNR should be alphanumeric, airport codes 3 letters
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return null;

    // Format passenger name (LAST/FIRST MR → First Last)
    const nameParts = name.split('/');
    const lastName  = nameParts[0]?.replace(/\s+/g, '') || '';
    const firstName = (nameParts[1] || '').replace(/\s+/g, ' ').trim();
    const fullName  = firstName ? `${firstName} ${lastName}` : lastName;

    // Convert Julian day to calendar date
    const flightDate = julianToDate(parseInt(julianDay, 10));

    return {
      passenger:  fullName || name,
      pnr:        pnr,
      from:       from,
      to:         to,
      carrier:    carrier,
      flight:     `${carrier}${flightRaw.replace(/^0+/, '')}`,
      date:       flightDate,
      seat:       seat,
      sequence:   seqRaw.replace(/^0+/, ''),
      eTicket:    eTicket,
      legs:       legs,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Convert a Julian day-of-year (1–365) to a human-readable date string.
 * Assumes the current year if the day is in the future, else next year.
 * @param {number} julian
 * @returns {string}
 */
function julianToDate(julian) {
  if (!julian || isNaN(julian)) return '—';
  const now   = new Date();
  let year    = now.getFullYear();
  const date  = new Date(year, 0);           // Jan 1
  date.setDate(julian);
  // If the resulting date is in the past by more than a day, try next year
  if (date < now && (now - date) > 86400000) {
    date.setFullYear(year + 1, 0);
    date.setDate(julian);
  }
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Render the decoded boarding pass fields into the boarding card widget.
 * @param {Object} data — Object returned by decodeBoardingPass()
 */
function renderBoardingPass(data) {
  const fields = [
    { label: 'Passenger',    value: data.passenger },
    { label: 'PNR / Booking',value: data.pnr },
    { label: 'From',         value: data.from },
    { label: 'To',           value: data.to },
    { label: 'Flight',       value: data.flight },
    { label: 'Date',         value: data.date },
    { label: 'Seat',         value: data.seat },
    { label: 'Sequence',     value: data.sequence },
    { label: 'Ticket Type',  value: data.eTicket },
    { label: 'Legs',         value: data.legs },
  ];

  boardingGrid.innerHTML = fields.map(f => `
    <div class="boarding-field">
      <span class="boarding-field-label">${f.label}</span>
      <span class="boarding-field-value">${f.value || '—'}</span>
    </div>
  `).join('');

  boardingCard.hidden = false;
}

/* ═══════════════════════════════════════════════════════════════
   9. HISTORY TABLE
═══════════════════════════════════════════════════════════════ */
/**
 * Prepend a new row to the history <tbody>.
 * @param {Object} entry   — { ts, type, value, isBoarding }
 * @param {number} total   — Total scan count (used for row number)
 */
function prependHistoryRow(entry, total) {
  // Remove empty-state row on first scan
  if (emptyRow) emptyRow.remove();

  const tr = document.createElement('tr');
  tr.classList.add('new-row');

  const badgeClass = getBadgeClass(entry.type, entry.isBoarding);
  const displayType = entry.isBoarding ? 'BOARDING' : entry.type;

  tr.innerHTML = `
    <td>${total}</td>
    <td>${formatTimestamp(entry.ts)}</td>
    <td><span class="type-badge ${badgeClass}">${displayType}</span></td>
    <td>${escapeHtml(truncate(entry.value, 120))}</td>
  `;

  historyBody.insertBefore(tr, historyBody.firstChild);
}

/** Map type string to CSS badge class */
function getBadgeClass(type, isBoarding) {
  if (isBoarding)         return 'boarding';
  if (type === 'AZTEC')   return 'aztec';
  if (type === 'PDF_417') return 'pdf417';
  return 'unknown';
}

/** Update the "N scans" count badge */
function updateHistoryCount() {
  const n = scanHistory.length;
  historyCount.textContent = `${n} scan${n !== 1 ? 's' : ''}`;
}

/** Clear all history and reset the table */
function clearHistory() {
  scanHistory  = [];
  lastScan     = '';
  historyBody.innerHTML = '';

  // Restore empty row
  const tr = document.createElement('tr');
  tr.id = 'emptyRow';
  tr.className = 'empty-row';
  tr.innerHTML = '<td colspan="4">No scans yet. Start the scanner to begin.</td>';
  historyBody.appendChild(tr);

  updateHistoryCount();
  btnClear.disabled  = true;
  btnExport.disabled = true;
  resultTextEl.value = '';
  barcodeTypeEl.textContent = '—';
  scanTimeEl.textContent    = '—';
  boardingCard.hidden = true;
  btnCopy.disabled = true;
}

/* ═══════════════════════════════════════════════════════════════
   10. CSV EXPORT
═══════════════════════════════════════════════════════════════ */
/**
 * Generate a CSV file from scanHistory and trigger a browser download.
 */
function exportCSV() {
  if (scanHistory.length === 0) return;

  const header = ['#', 'Timestamp', 'Type', 'Is Boarding Pass', 'Decoded Value'];
  const rows   = scanHistory.map((e, i) => [
    scanHistory.length - i,          // row number (newest = 1)
    formatTimestampISO(e.ts),
    e.type,
    e.isBoarding ? 'Yes' : 'No',
    `"${e.value.replace(/"/g, '""')}"`, // escape quotes
  ]);

  const csv = [header, ...rows].map(r => r.join(',')).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `scanx-history-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════════════════════════
   11. UI EFFECTS
═══════════════════════════════════════════════════════════════ */
/**
 * Trigger the green flash overlay on the camera panel.
 */
function triggerFlash() {
  scanFlash.classList.remove('flash');
  // Force reflow so the animation re-triggers
  void scanFlash.offsetWidth;
  scanFlash.classList.add('flash');
}

/* ═══════════════════════════════════════════════════════════════
   12. ERROR HANDLING
═══════════════════════════════════════════════════════════════ */
/**
 * Handle camera or permission errors gracefully.
 * @param {Error} err
 */
function handleCameraError(err) {
  loadingOvl.classList.add('hidden');
  btnStart.disabled = false;
  isScanning = false;

  let message = 'Camera error. Please try again.';

  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    message = '🔒 Camera permission denied.\n\nPlease allow camera access in your browser settings and reload the page.';
  } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
    message = '📷 No camera found.\n\nMake sure your device has a camera and it is not in use by another app.';
  } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
    message = '⚠ Camera is in use by another application.\n\nClose the other app and try again.';
  } else if (err.name === 'OverconstrainedError') {
    message = '⚙ Camera constraints could not be satisfied.\n\nTry a different camera.';
  } else if (err.message) {
    message = err.message;
  }

  resultTextEl.value = message;
  console.error('Camera error:', err);
}

/* ═══════════════════════════════════════════════════════════════
   13. UTILITY HELPERS
═══════════════════════════════════════════════════════════════ */
/**
 * Format a Date as "HH:MM:SS DD/MM/YYYY"
 * @param {Date} d
 * @returns {string}
 */
function formatTimestamp(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}  `
       + `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * Format a Date as ISO 8601 for CSV export.
 * @param {Date} d
 * @returns {string}
 */
function formatTimestampISO(d) {
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Truncate a string at `max` characters, appending "…" if cut.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function truncate(str, max) {
  return str.length > max ? str.substring(0, max) + '…' : str;
}

/**
 * Escape HTML special characters to prevent XSS in table cells.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ═══════════════════════════════════════════════════════════════
   14b. MODE TABS — Camera ↔ Upload
═══════════════════════════════════════════════════════════════ */
/**
 * Switch between "Live Camera" and "Upload Image" modes.
 * Camera is stopped when switching to upload to free the device.
 * @param {'camera'|'upload'} mode
 */
function switchMode(mode) {
  if (mode === 'camera') {
    tabCamera.classList.add('active');
    tabUpload.classList.remove('active');
    cameraControls.hidden = false;
    uploadPanel.hidden    = true;
    cameraPanel.hidden    = false;
  } else {
    tabUpload.classList.add('active');
    tabCamera.classList.remove('active');
    cameraControls.hidden = true;
    uploadPanel.hidden    = false;
    cameraPanel.hidden    = true;
    // Free the camera stream when switching away
    if (isScanning) stopScanner();
  }
}

/* ═══════════════════════════════════════════════════════════════
   14c. IMAGE UPLOAD — Decode a barcode from a static image file
═══════════════════════════════════════════════════════════════ */
/**
 * Handle a File object dropped or selected by the user.
 * Renders a preview then runs ZXing's still-image decoder.
 * @param {File} file
 */
async function handleUploadedFile(file) {
  // Validate MIME type
  if (!file.type.startsWith('image/')) {
    uploadStatus.textContent = '⚠ Please upload an image file (PNG, JPG, GIF, WebP, BMP).';
    uploadStatus.className   = 'upload-status error';
    return;
  }

  // ── Show image preview ──
  const objectURL = URL.createObjectURL(file);
  uploadedImg.src = objectURL;
  uploadedImg.onload = () => URL.revokeObjectURL(objectURL); // free memory

  // Transition: hide drop zone, show preview row
  dropZone.hidden          = true;
  uploadPreviewRow.hidden  = false;
  uploadScanningOvl.hidden = false;
  uploadStatus.textContent = 'Decoding…';
  uploadStatus.className   = 'upload-status';

  try {
    // Ensure ZXing is available
    if (typeof ZXingBrowser === 'undefined') {
      throw new Error('ZXing library not loaded.');
    }

    const { BrowserMultiFormatReader, BarcodeFormat, DecodeHintType } = ZXingBrowser;

    // Build hints — same formats as live scanner
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.AZTEC,
      BarcodeFormat.PDF_417,
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);

    const reader = new BrowserMultiFormatReader(hints);

    // decodeFromImageUrl expects a URL — we use the already-set img src
    // Wait for the image to be fully painted first
    await new Promise(r => setTimeout(r, 80));

    const result = await reader.decodeFromImageElement(uploadedImg);

    // ── Success ──
    const text     = result.getText();
    const typeName = formatName(result.getBarcodeFormat());

    uploadScanningOvl.hidden = true;
    uploadStatus.textContent = `✓ Decoded as ${typeName}`;
    uploadStatus.className   = 'upload-status success';

    // Reuse the same result-display + history pipeline as live scan
    playBeep();
    triggerUploadFlash();

    const ts = new Date();
    barcodeTypeEl.textContent = typeName;
    scanTimeEl.textContent    = formatTimestamp(ts);
    resultTextEl.value        = text;
    btnCopy.disabled          = false;

    const boardingData = decodeBoardingPass(text, typeName);
    if (boardingData) renderBoardingPass(boardingData);
    else boardingCard.hidden = true;

    const entry = { ts, type: typeName, value: text, isBoarding: !!boardingData, source: 'upload' };
    scanHistory.unshift(entry);
    prependHistoryRow(entry, scanHistory.length);
    updateHistoryCount();

    btnClear.disabled  = false;
    btnExport.disabled = false;

  } catch (err) {
    uploadScanningOvl.hidden = true;

    // ZXing throws NotFoundException when no barcode found
    if (err?.name === 'NotFoundException' || err?.message?.includes('No MultiFormat')) {
      uploadStatus.textContent = '✕ No Aztec or PDF417 barcode found in this image.\n\nTry a clearer photo or a different image.';
    } else {
      uploadStatus.textContent = `✕ Error: ${err.message}`;
    }
    uploadStatus.className = 'upload-status error';
    console.warn('Upload decode error:', err);
  }
}

/**
 * Brief flash on the uploaded image thumbnail to signal success.
 */
function triggerUploadFlash() {
  uploadedImg.style.transition = 'box-shadow .1s';
  uploadedImg.style.boxShadow  = `0 0 0 3px var(--accent)`;
  setTimeout(() => { uploadedImg.style.boxShadow = 'none'; }, 500);
}

/**
 * Reset the upload panel back to the drop zone state.
 */
function resetUploadPanel() {
  dropZone.hidden         = false;
  uploadPreviewRow.hidden = true;
  uploadedImg.src         = '';
  uploadStatus.textContent = '—';
  uploadStatus.className   = 'upload-status';
  uploadScanningOvl.hidden = true;
  fileInput.value          = '';   // allow re-selecting the same file
}


/**
 * Copy the current result text to the clipboard.
 */
async function copyResult() {
  const text = resultTextEl.value;
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    const orig = btnCopy.innerHTML;
    btnCopy.innerHTML = '<span class="btn-icon">✓</span> Copied!';
    setTimeout(() => { btnCopy.innerHTML = orig; }, 1800);
  } catch (_) {
    // Fallback for browsers without clipboard API
    resultTextEl.select();
    document.execCommand('copy');
  }
}

/* ═══════════════════════════════════════════════════════════════
   15. EVENT LISTENERS
═══════════════════════════════════════════════════════════════ */
btnStart.addEventListener('click',  startScanner);
btnStop.addEventListener('click',   stopScanner);
btnSwitch.addEventListener('click', switchCamera);
btnCopy.addEventListener('click',   copyResult);
btnClear.addEventListener('click',  clearHistory);
btnExport.addEventListener('click', exportCSV);

// ── Mode tabs ──
tabCamera.addEventListener('click', () => switchMode('camera'));
tabUpload.addEventListener('click', () => switchMode('upload'));

// ── File input (click-to-browse) ──
fileInput.addEventListener('change', e => {
  const file = e.target.files?.[0];
  if (file) handleUploadedFile(file);
});

// ── Retry / choose another image ──
btnRetryUpload.addEventListener('click', resetUploadPanel);

// ── Drag-and-drop onto the drop zone ──
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files?.[0];
  if (file) handleUploadedFile(file);
});

// ── Paste an image from clipboard (Ctrl+V / Cmd+V) ──
document.addEventListener('paste', e => {
  // Only handle paste when in upload mode
  if (uploadPanel.hidden) return;
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        resetUploadPanel();
        handleUploadedFile(file);
      }
      break;
    }
  }
});

// Stop scanner if user navigates away (avoid zombie streams)
window.addEventListener('beforeunload', stopScanner);

// Re-enumerate cameras if devices change (e.g., USB camera plugged in)
navigator.mediaDevices?.addEventListener('devicechange', async () => {
  cameras = [];
  await enumerateCameras();
  if (cameras.length < 2) btnSwitch.disabled = true;
});

/* ═══════════════════════════════════════════════════════════════
   16. INIT — Check browser compatibility on load
═══════════════════════════════════════════════════════════════ */
(function init() {
  // Check for required APIs
  const missing = [];
  if (!navigator.mediaDevices?.getUserMedia) missing.push('getUserMedia');
  if (typeof ZXingBrowser === 'undefined')   missing.push('ZXing library');

  if (missing.length > 0) {
    resultTextEl.value =
      `⚠ Your browser is missing required features: ${missing.join(', ')}.\n\n`
      + 'Please use Chrome 80+, Edge 80+, or Firefox 75+ with a secure context (HTTPS or localhost).';
    btnStart.disabled = true;
    return;
  }

  // Hide loading overlay initially (shown only when scanner starts)
  loadingOvl.classList.add('hidden');

  console.log('ScanX ready. Supported formats: Aztec, PDF417, Boarding Passes.');
})();
