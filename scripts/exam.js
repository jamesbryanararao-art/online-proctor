/* exam.js - exam runtime logic (render questions, timing, submission, proctoring checks) */
// Fallback API URL (kept for backwards-compatibility). The page may inject
// a deployment-specific URL into `window.ANSWER_API_URL` after this script
// is loaded (see inline script in `index.html`/`exam.html`). To ensure the
// client uses the injected URL, resolve the effective API URL at call time.
const FALLBACK_ANSWER_API_URL = "https://script.google.com/macros/s/AKfycby6B9OgDmMNJqGmDNBvF7MJnAaV1wXTnvmzjjCEqn8vIh1zEFx7Izn3jxEJIsvnuXF4/exec";

// Add this near your other let/const variables
let allQuestionsMasterList = [];
let visitedQuestions = new Set();
let examGlobalTimerSeconds = null; // Stores the E2 value (in seconds)
let isGlobalTimerActive = false;   // Flag to switch modes
let globalTimerInterval = null;    // Reference to the interval

function apiUrl() {
  try {
    if (typeof window !== 'undefined' && window.ANSWER_API_URL) return window.ANSWER_API_URL;
  } catch (e) {}
  return FALLBACK_ANSWER_API_URL;
}

// Modal instances (some modals live in index.html; ensure they exist or create lightweight fallbacks)
const warningModalEl = document.getElementById('warningModal');
const confirmModalEl = document.getElementById('confirmModal');
const duplicateModalEl = document.getElementById('duplicateModal');
const errorModalEl = document.getElementById('errorModal');

const warningModal = warningModalEl ? new bootstrap.Modal(warningModalEl) : null;
const confirmModal = confirmModalEl ? new bootstrap.Modal(confirmModalEl) : null;
const duplicateModal = duplicateModalEl ? new bootstrap.Modal(duplicateModalEl) : null;
const errorModal = errorModalEl ? new bootstrap.Modal(errorModalEl) : null;

let questions = [];
let answersMap = {};
let userAnswers = {};
let score = 0;
let current = 0;
let timer;
let remaining = 30;
let examTimerSeconds = 30;
let userInfo = { lastName: '', firstName: '', code: '', startTime: '', endTime: '', date: '', violated: false };
// Behavior warnings (persisted across reloads in sessionStorage). This counts violations
// such as switching away, reload attempts, and large screen resizes.
let behaviorWarnings = 0;
try { behaviorWarnings = parseInt(sessionStorage.getItem('exam_behavior_warnings_v1') || '0', 10) || 0; } catch (e) { behaviorWarnings = 0; }
let isExamActive = false;
let violationLock = false;
let confirmOpen = false;
// Warning countdown state
let warningCountdownInterval = null;
let warningCountdownRemaining = 0;

// Skipped questions are stored as a second batch in sessionStorage (preserve remaining seconds)
let skippedBatch = [];
let inSkippedPhase = false;

// Mobile device detection - used to disable resize violations on mobile
function isMobileDevice() {
  // Check user agent for mobile indicators
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i;
  
  // Check screen size (mobile typically < 768px width)
  const isSmallScreen = window.innerWidth < 768;
  
  // Check touch capability
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  
  // Return true if any mobile indicator is present
  return mobileRegex.test(userAgent) || (isSmallScreen && isTouchDevice);
}

// Detect mobile at load time
const IS_MOBILE_DEVICE = isMobileDevice();

// Log device type for debugging (helps instructors troubleshoot)
console.log(`Device detected as: ${IS_MOBILE_DEVICE ? 'MOBILE' : 'DESKTOP'}`);
console.log(`Screen size: ${window.innerWidth}x${window.innerHeight}`);
console.log(`User agent: ${navigator.userAgent}`);

function saveSkippedBatch() {
  try { localStorage.setItem('exam_skipped_batch_v1', JSON.stringify(skippedBatch)); } catch (e) { console.warn('save skipped batch failed', e); }
}

function loadSkippedBatch() {
  try { skippedBatch = JSON.parse(localStorage.getItem('exam_skipped_batch_v1') || '[]'); } catch (e) { skippedBatch = []; }
}

// load saved skipped batch if any
loadSkippedBatch();

// Offline queue key
const OFFLINE_QUEUE_KEY = 'exam_offline_queue_v1';

function getOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]'); } catch { return []; }
}

function pushOfflineQueue(item) {
  const q = getOfflineQueue(); q.push(item); localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));
}

async function flushOfflineQueue() {
  const q = getOfflineQueue();
  if (!q.length || !isOnline()) return;
  for (const item of q) {
    try {
      const res = await fetch(apiUrl(), { method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(item) });
      if (res.ok) {
        // remove the item from queue
        const currentQ = getOfflineQueue();
        currentQ.shift();
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(currentQ));
      } else break; // stop on first failure
    } catch (e) { break; }
  }
}

// flush on reconnect
window.addEventListener('online', () => { flushOfflineQueue(); });

const examQuiz = document.getElementById('examQuiz');
const examProgressEl = document.getElementById('examProgress');
const examTimerEl = document.getElementById('examTimer');
const examLoading = document.getElementById('examLoading');
// questionBar removed from UI - keep as null to avoid accidental DOM access
const questionBarEl = null;
// total question count for final scoring (preserve original batch size)
let totalQuestionCount = 0;
let initialTotalCount = 0; // preserve the initial main-batch count for final scoring
// totalRenderedCount = sum of main batch + skipped batch (used for final total)
let totalRenderedCount = 0;

function isOnline() { return navigator.onLine; }

function updateHudEl(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.add('updated');
  setTimeout(() => el.classList.remove('updated'), 600);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// --- STEP 2C: THE UPDATED TIMER DISPLAY LOGIC ---
function startGlobalCountdown() {
  if (globalTimerInterval) clearInterval(globalTimerInterval);
  
  const timerPill = document.getElementById('examTimer'); // Using your existing ID 'examTimer'
  
  globalTimerInterval = setInterval(() => {
    if (examGlobalTimerSeconds <= 0) {
      clearInterval(globalTimerInterval);
      finishExam("Total Exam Time Expired"); // Changed to match your function name 'finishExam'
      return;
    }
    
    examGlobalTimerSeconds--;
    if (timerPill) {
      updateHudEl(timerPill, 'Time Left: ' + formatTime(examGlobalTimerSeconds));
      // Add a red warning if less than 1 minute left
      if (examGlobalTimerSeconds < 60) {
        timerPill.classList.add('bg-danger');
      }
    }
  }, 1000);
}

function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

// Normalize question code to a canonical form: 'Q' + zero-padded number (e.g. Q014)
function normalizeCode(raw) {
  if (!raw && raw !== 0) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const u = s.toUpperCase();
  // Q-prefixed
  let m = u.match(/^Q0*(\d+)$/i);
  if (m) return 'Q' + String(m[1]).padStart(3, '0');
  // numeric only
  m = u.match(/^0*(\d+)$/);
  if (m) return 'Q' + String(m[1]).padStart(3, '0');
  // otherwise fallback to uppercase trimmed
  return u;
}

// Question bar helpers: render small pills for each randomized question and update states
function renderQuestionBar() { /* no-op: per-user request the question list is hidden */ }
function updateQuestionBarState() { /* no-op: per-user request the question list is hidden */ }

function requestFullscreen() {
  // Fullscreen enforcement removed due to reliability issues; keep a no-op for compatibility
  return Promise.resolve();
}

function inFullscreen() {
  return false;
}

function startTimerForQuestion() {
  clearInterval(timer);
  const currentQ = questions[current];
  remaining = currentQ ? (currentQ.timerSeconds || examTimerSeconds) : examTimerSeconds;
  updateHudEl(examTimerEl, 'Time: ' + formatTime(remaining));
  timer = setInterval(() => {
    remaining--;
    updateHudEl(examTimerEl, 'Time: ' + formatTime(remaining));
    if (remaining <= 0) {
      clearInterval(timer);
      autoSubmitAnswer();
    }
    // no question pill small-time update (UI simplified)
  }, 1000);
}

// Variant: allow starting timer with a specific remaining seconds (used when resuming after reload)
function startTimerForQuestionWithRemaining(overrideSeconds) {
  clearInterval(timer);
  const currentQ = questions[current];
  if (typeof overrideSeconds === 'number' && overrideSeconds >= 0) remaining = overrideSeconds;
  else remaining = currentQ ? (currentQ.timerSeconds || examTimerSeconds) : examTimerSeconds;
  updateHudEl(examTimerEl, 'Time: ' + formatTime(remaining));
  timer = setInterval(() => {
    remaining--;
    updateHudEl(examTimerEl, 'Time: ' + formatTime(remaining));
    if (remaining <= 0) {
      clearInterval(timer);
      autoSubmitAnswer();
    }
  }, 1000);
}

function autoSubmitAnswer() {
  const ansInput = document.getElementById('ansInput');
  const ans = ansInput ? ansInput.value.trim() || '-' : '-';
  const q = questions[current];
  if (q) {
    userAnswers[q.code] = ans;
    // Persist user answers to localStorage for reliability
    try { localStorage.setItem('exam_user_answers_v1', JSON.stringify(userAnswers)); } catch (e) {}
  }
  submitAnswer(ans);
}

function showConfirmModal(answer, onConfirm) {
  if (!confirmModalEl) { onConfirm(); return; }
  document.getElementById('confirmText').textContent = `Are you sure you want to submit "${answer}" as your final answer?`;
  confirmModal.show(); confirmOpen = true;
  const yes = document.getElementById('confirmYes');
  const no = document.getElementById('confirmNo');
  function handleYes() { confirmModal.hide(); confirmOpen = false; yes.onclick = null; no.onclick = null; onConfirm(); }
  function handleNo() { confirmModal.hide(); confirmOpen = false; yes.onclick = null; no.onclick = null; }
  yes.onclick = handleYes; no.onclick = handleNo;
}

function submitAnswer(userAnswer) {
  clearInterval(timer);
  const q = questions[current];
  if (!q) return;
  const correct = answersMap[q.code] || '';

  // 1. Save the answer
  userAnswers[q.code] = userAnswer;

  // 2. Persist user answers and clear drafts
  try {
    localStorage.setItem('exam_user_answers_v1', JSON.stringify(userAnswers));
    const drafts = JSON.parse(localStorage.getItem('exam_drafts_v1') || '{}');
    delete drafts[q.code];
    localStorage.setItem('exam_drafts_v1', JSON.stringify(drafts));
  } catch (e) {}

  // 3. Remove from skipped batch if applicable
  const sbIndex = skippedBatch.findIndex(s => s.code === q.code);
  if (sbIndex !== -1) {
    skippedBatch.splice(sbIndex, 1);
    saveSkippedBatch();
    const sqUp = document.getElementById('skippedPill');
    if (sqUp) sqUp.textContent = `Check Skipped Questions ${skippedBatch.length}`;
  }

  // 4. Update Score
  if (userAnswer.toLowerCase() === correct.toLowerCase()) score++;

  // 5. Move to next question index
  current++;

  // --- UPDATED HUD LOGIC START ---
  // We count the keys in userAnswers to get the actual number of answered questions
  const answeredCount = Object.keys(userAnswers).length;
  // We use initialTotalCount to ensure the denominator (e.g., 50) stays fixed
  const totalFixed = typeof initialTotalCount !== 'undefined' ? initialTotalCount : questions.length;
  
  updateHudEl(examProgressEl, `Questions ${answeredCount}/${totalFixed}`);
  // --- UPDATED HUD LOGIC END ---

  const sqEl = document.getElementById('skippedPill');
  if (sqEl) sqEl.textContent = `Check Skipped Questions ${skippedBatch.length}`;

  // 6. Continue to next question if available
  if (current < questions.length) {
    renderQuestion(current);
    return;
  }

  // 7. Handle Skipped Phase (if main list is done but skips exist)
  if (skippedBatch.length) {
    if (sqEl) {
      sqEl.classList.add('updated');
      setTimeout(() => sqEl.classList.remove('updated'), 800);
    }
    setTimeout(() => {
      const appended = skippedBatch.map(s => ({
        code: s.code,
        question: s.question,
        timerSeconds: s.remaining || s.timerSeconds
      }));
      
      // Reload questions array with skipped items
      questions = appended;
      
      // Preserve the total count for final scoring
      totalQuestionCount = initialTotalCount || totalQuestionCount || questions.length;
      
      skippedBatch = [];
      saveSkippedBatch();
      inSkippedPhase = true;

      // --- UPDATED HUD FOR SKIPPED PHASE ---
      // Ensure the counter doesn't reset to "1/5" but stays at "45/50" etc.
      const currentAnswered = Object.keys(userAnswers).length;
      updateHudEl(examProgressEl, `Questions ${currentAnswered}/${initialTotalCount}`);
      // -------------------------------------

      if (sqEl) sqEl.textContent = `Check Skipped Questions 0/${questions.length}`;
      
      current = 0;
      renderQuestion(0);
    }, 600);
    return;
  }

  // 8. Finish Exam
  finishExam();
}

// Add skip button handler used in renderQuestion: store skipped question in skippedBatch (sessionStorage)
function markSkipForCurrent() {
  const currentQ = questions[current];
  if (!currentQ) return;

  // 1. Record as visited
  visitedQuestions.add(currentQ.code); 

  // 2. Save current remaining time and add to skippedBatch
  const toSkip = Object.assign({}, currentQ, { remaining });
  
  // Prevent duplicates in skippedBatch
  if (!skippedBatch.find(s => s.code === toSkip.code)) {
    skippedBatch.push(toSkip);
    saveSkippedBatch();
  }

  // 3. Remove the skipped question from the current questions array
  questions.splice(current, 1);

  // --- UPDATED HUD LOGIC START ---
  // Skipping keeps the 'answered' count (numerator) the same.
  const answeredCount = Object.keys(userAnswers).length;
  // Use the fixed initial total so the denominator doesn't shrink.
  // Fallback: if initialTotalCount isn't set, we estimate it by adding current + skipped + answered.
  const totalFixed = typeof initialTotalCount !== 'undefined' 
    ? initialTotalCount 
    : (questions.length + skippedBatch.length + answeredCount);

  updateHudEl(examProgressEl, `Questions ${answeredCount}/${totalFixed}`);
  // --- UPDATED HUD LOGIC END ---

  const sq = document.getElementById('skippedPill'); 
  if (sq) sq.textContent = `Check Skipped Questions ${skippedBatch.length}`;

  // 4. Render next question (which slid into 'current' index after splice)
  if (current < questions.length) {
    renderQuestion(current);
    return;
  }

  // 5. Handle Skipped Phase (if main list is done but skips exist)
  if (skippedBatch.length) {
    // Reload skipped questions into the main array
    questions = skippedBatch.map(s => ({ 
      code: s.code, 
      question: s.question, 
      timerSeconds: s.remaining // Use saved remaining time
    }));
    
    // Clear batch and set phase
    skippedBatch = [];
    saveSkippedBatch();
    inSkippedPhase = true;
    
    // Reset index
    current = 0;
    
    // Update HUD for start of skipped phase
    const currentAnswered = Object.keys(userAnswers).length;
    updateHudEl(examProgressEl, `Questions ${currentAnswered}/${initialTotalCount || questions.length}`);
    
    const sq2 = document.getElementById('skippedPill'); 
    if (sq2) sq2.textContent = `Check Skipped Questions 0/${questions.length}`;
    
    renderQuestion(current);
    return;
  }

  // 6. Finish Exam if nothing left
  finishExam();
}

async function fetchAllQuestionsAndAnswers() {
  try {
  // Prefer a prefetched payload stored by login flow to avoid double-loading
  let data = null;
  try {
    const pref = sessionStorage.getItem('exam_last_server_payload');
    if (pref) {
      data = JSON.parse(pref);
      // clear stored prefetched payload so subsequent runs fetch fresh data
      try { sessionStorage.removeItem('exam_last_server_payload'); } catch(e){}
      console.debug('Using prefetched server payload');
    }
  } catch (e) { data = null; }
  if (!data) {
    const res = await fetch(`${apiUrl()}?action=getAllQuestionsAndAnswers&code=${encodeURIComponent(userInfo.code)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  }

  if (data.globalExamTimerSeconds && data.globalExamTimerSeconds > 0) {
      examGlobalTimerSeconds = data.globalExamTimerSeconds;
      isGlobalTimerActive = true;
      startGlobalCountdown(); 
    }
    // Server may return either array or map; normalize into an array.
    examTimerSeconds = data.defaultTimerSeconds || 30;
    let questionsArr = [];
    if (Array.isArray(data.questions) && data.questions.length) {
      questionsArr = data.questions.slice();
    } else if (Array.isArray(data.questionsMap) && data.questionsMap.length) {
      questionsArr = data.questionsMap.slice();
    } else if (data.questionsMap && typeof data.questionsMap === 'object' && Object.keys(data.questionsMap).length) {
      questionsArr = Object.values(data.questionsMap || {});
    }

    // If no questions at all, surface server payload and abort
    if (!questionsArr.length) {
      const payloadStr = (function(){ try { return JSON.stringify(data); } catch(e) { return String(data); } })();
      const truncated = payloadStr.length > 2000 ? payloadStr.slice(0,2000) + '... (truncated)' : payloadStr;
      const url = `${apiUrl()}?action=getAllQuestionsAndAnswers&code=${encodeURIComponent(userInfo.code)}`;
      console.error('No questions returned from server for URL:', url, 'payload:', data);
      const msg = `No questions returned from server for code "${userInfo.code}". Server payload: ${truncated}`;
      if (errorModalEl) {
        const et = document.getElementById('errorText'); if (et) et.textContent = msg;
        const okBtn = document.getElementById('errorOk'); if (okBtn) okBtn.onclick = () => { try { sessionStorage.removeItem('exam_in_progress_v1'); } catch(e){}; location.href = 'index.html'; };
        errorModal.show();
        try { sessionStorage.setItem('exam_last_server_payload', JSON.stringify(data)); } catch(e){}
        return false;
      }
      throw new Error('No questions');
    }

    // Ensure each item has a code and normalize them.
    let genId = 1;
    questionsArr = questionsArr.map(q => {
      const obj = Object.assign({}, q);
      if (!obj.code || String(obj.code).trim() === '') {
        obj.code = 'Q' + String(genId++).padStart(3, '0');
      }
      obj.code = normalizeCode(obj.code) || obj.code;
      // Ensure answer field exists (keep empty string allowed)
      if (typeof obj.answer === 'undefined' || obj.answer === null) obj.answer = '';
      // Ensure timerSeconds exists
      if (typeof obj.timerSeconds === 'undefined' || obj.timerSeconds === null) obj.timerSeconds = examTimerSeconds;
      return obj;
    });

    // Detect numeric codes and fill missing gaps so client has a contiguous set
    const numericMap = {};
    const numericValues = [];
    questionsArr.forEach(q => {
      const m = String(q.code).toUpperCase().match(/^Q0*(\d+)$/);
      if (m) {
        const n = parseInt(m[1], 10);
        numericMap[n] = q;
        numericValues.push(n);
      }
    });
    let fullQuestions = [];
    if (numericValues.length) {
      const min = Math.min.apply(null, numericValues);
      const max = Math.max.apply(null, numericValues);
      for (let i = min; i <= max; i++) {
        if (numericMap[i]) {
          fullQuestions.push(numericMap[i]);
        } else {
          // synthesize placeholder for missing rows so client knows about missing items
          fullQuestions.push({ code: 'Q' + String(i).padStart(3, '0'), question: '[MISSING QUESTION ' + ('Q' + String(i).padStart(3, '0')) + ']', answer: '', timerSeconds: examTimerSeconds });
        }
      }
    } else {
      // no numeric codes found, fall back to using existing array order
      fullQuestions = questionsArr.slice();
    }

    // Randomize question order for each attempt (display order only; codes preserved)
    // We keep codes as-is so client-side checking remains accurate
    questions = shuffleArray(fullQuestions.slice());

    allQuestionsMasterList = questions.slice();

    // Save the full normalized (now randomized) question set to sessionStorage so scoring is deterministic client-side
    try { sessionStorage.setItem('exam_all_questions_v1', JSON.stringify(questions)); } catch (e) { console.warn('Save all questions failed', e); }
    // Also keep a copy of raw payload for debugging
    try { sessionStorage.setItem('exam_last_server_payload', JSON.stringify(data)); } catch(e){}
  // Log loaded items for debugging: codes and truncated question text
  try { console.table(questions.map(x => ({ code: x.code, question: (x.question||'').slice(0,80) }))); } catch(e){}
  // If the sheet uses sequential codes like Q001..QXXX, detect missing codes (gaps)
  try {
    const codes = questions.map(q => String(q.code||'').trim()).filter(Boolean);
    // Support both Q-prefixed codes (Q001) and numeric-only codes (1, 2, 03)
    const qMatches = codes.map(c => {
      const u = c.toUpperCase();
      let m = u.match(/^Q0*(\d+)$/i);
      if (m) return parseInt(m[1], 10);
      // numeric-only
      m = u.match(/^0*(\d+)$/);
      if (m) return parseInt(m[1], 10);
      return null;
    }).filter(n => n !== null);
    if (qMatches.length) {
      const min = Math.min(...qMatches); const max = Math.max(...qMatches);
      const missing = [];
      for (let i = min; i <= max; i++) if (!qMatches.includes(i)) missing.push(i);
      if (missing.length) {
        const missingCodes = missing.map(n => 'Q' + String(n).padStart(3,'0'));
        const msg = `Missing question codes detected: ${missingCodes.join(', ')}.\nThis may indicate empty rows or parsing issues in the sheet.`;
        console.warn(msg);
        // If Q014 specifically is missing, surface a clearer modal so instructor can fix
        if (missingCodes.includes('Q014')) {
          if (errorModalEl) {
            const et = document.getElementById('errorText'); if (et) et.textContent = msg + '\nReturning to login is recommended.';
            const okBtn = document.getElementById('errorOk'); if (okBtn) okBtn.onclick = () => { try { sessionStorage.removeItem('exam_in_progress_v1'); } catch(e){}; location.href = 'index.html'; };
            errorModal.show();
          } else {
            alert(msg);
          }
          return false;
        }
      }
    }
  } catch(e) { console.warn('Gap detection failed', e); }
  // Debug: log counts
  try { console.debug('Loaded questions count (map keys):', Object.keys(questionsMap).length, 'values:', questions.length); } catch(e){}
  // Detect duplicate codes (server may have used code as object key and overwritten duplicates)
  const codeCounts = {};
  questions.forEach(q => { const c = (q && q.code) ? String(q.code).trim() : '__MISSING__'; codeCounts[c] = (codeCounts[c] || 0) + 1; });
  const duplicates = Object.entries(codeCounts).filter(([k,v]) => v > 1 && k !== '__MISSING__');
  const missingCodeCount = codeCounts['__MISSING__'] || 0;
  if (duplicates.length || missingCodeCount) {
    let msg = '';
    if (missingCodeCount) msg += `Found ${missingCodeCount} question(s) with missing code values.\n`;
    if (duplicates.length) {
      msg += 'Duplicate question codes detected:\n';
      duplicates.forEach(([k,v]) => { msg += `${k} (count: ${v})\n`; });
    }
    msg += '\nThis can cause some questions to be overwritten or omitted. Please fix the sheet or contact your instructor.';
    console.warn(msg);
    // Show the error modal and provide a Return to Login action for these cases
    if (errorModalEl) {
      const et = document.getElementById('errorText'); if (et) et.textContent = msg;
      // wire errorOk to return to login for this case
      const okBtn = document.getElementById('errorOk'); if (okBtn) okBtn.onclick = () => { try { sessionStorage.removeItem('exam_in_progress_v1'); } catch(e){}; location.href = 'index.html'; };
      errorModal.show();
    } else {
      alert(msg);
    }
    return false;
  }
  // preserve initial main batch size
  totalQuestionCount = questions.length;
  initialTotalCount = questions.length;
  try { sessionStorage.setItem('exam_initial_total_v1', String(initialTotalCount)); } catch(e){}
  // Build answersMap using the normalized codes
  answersMap = Object.fromEntries(questions.map(q => [q.code, q.answer]));
  // Persist questions and answers map to localStorage for reliability/offline resume
  try {
    localStorage.setItem('exam_questions_v1', JSON.stringify(questions));
    localStorage.setItem('exam_answers_map_v1', JSON.stringify(answersMap));
  } catch (e) { console.warn('Persist QA to localStorage failed', e); }
    // clear any previous skipped/drafts cached for safety when a fresh main batch is loaded
  try { localStorage.removeItem('exam_skipped_batch_v1'); localStorage.removeItem('exam_drafts_v1'); skippedBatch = []; } catch(e){}
    // initialize HUD labels
    const prog = document.getElementById('examProgress'); if (prog) prog.textContent = `Questions 1/${questions.length}`;
    const sq = document.getElementById('skippedPill'); if (sq) sq.textContent = `Check Skipped Questions 0`;
    return true;
  } catch (err) {
    console.error('Fetch failed', err);
    if (errorModalEl) {
      const et = document.getElementById('errorText'); if (et) et.textContent = 'Error loading questions: ' + err.message;
      // If there are no questions, provide a direct button back to login to avoid user confusion
      const okBtn = document.getElementById('errorOk');
      if (okBtn) {
        okBtn.onclick = () => { try { sessionStorage.removeItem('exam_in_progress_v1'); } catch(e){}; location.href = 'index.html'; };
      }
      errorModal.show();
    } else alert('Error loading questions: ' + err.message);
    return false;
  }
}

function renderQuestion(index) {
  // Safety check
  if (!questions[index]) return;
  const q = questions[index];

  // 1. Mark this question code as visited
  visitedQuestions.add(q.code);

  // 2. FIXED HUD UPDATE:
  // Uses 'Object.keys(userAnswers).length' (actual answered count) 
  // and 'initialTotalCount' (fixed total)
  const totalFixed = (typeof initialTotalCount !== 'undefined' && initialTotalCount) ? initialTotalCount : questions.length;
  updateHudEl(examProgressEl, `Questions ${Object.keys(userAnswers).length}/${totalFixed}`);

  // Clear previous content
  examQuiz.innerHTML = '';

  // Update Skipped Pill
  const sqEl = document.getElementById('skippedPill'); 
  if (sqEl) sqEl.textContent = `Check Skipped Questions ${skippedBatch.length}`;

  // If we're rendering skipped-phase questions, use a darker card
  const card = document.createElement('div');
  card.className = 'card card-custom mx-auto fade-in' + (inSkippedPhase ? ' skipped-phase' : '');
  
  const questionDiv = document.createElement('div'); 
  questionDiv.className = 'question-text'; 
  questionDiv.innerHTML = q.question;

  // Detect choices: try to extract option markers like 'a)', 'a.' or inline sequences
  const lines = q.question.split(/\r?\n/).map(l => l.trim()).filter(l => l);
  const inlineOptRegex = /[A-Da-d][\)\.\]]\s*.*?(?=(?:\s*[A-Da-d][\)\.\]]\s*)|$)/g;
  const optionMatches = q.question.match(inlineOptRegex) || [];
  const optionLines = optionMatches.length ? optionMatches.map(s => s.trim()) : lines.filter(l => /^[A-Da-d][\)\.\]]/.test(l) || /^[A-D]\./.test(l));

  const tfDetected = /\b(true|false|T\/F|T or F)\b/i.test(q.question) || optionLines.some(l => /true|false/i.test(l));

  let inputHtml = '';
  if (optionLines.length >= 2) {
    // Render compact inline letter-only choices (A B C D)
    inputHtml = '<div class="mcq-inline options-container mb-2" id="optionsList">';
    optionLines.forEach((opt, i) => {
      const m = opt.match(/^[A-Da-d]/);
      const letter = (m ? m[0] : String.fromCharCode(65 + i)).toUpperCase();
      const text = opt.replace(/^[A-Da-d][\)\.\s]*/i,'').trim();
      const id = 'opt_' + i;
      inputHtml += `<label class="mcq-btn" title="${text.replace(/"/g,'&quot;')}"><input type="radio" name="mcq" id="${id}" value="${letter}" class="form-check-input me-2"> <span class="mcq-letter">${letter}</span></label>`;
    });
    inputHtml += '</div>';
  } else if (tfDetected) {
    // Render True/False
    inputHtml = '<div class="tf-options mb-2 options-container" id="optionsList">';
    ['True','False'].forEach((t,i) => { 
        const id = 'tf_' + i; 
        inputHtml += `<label class="tf-btn"><input type="radio" name="mcq" id="${id}" value="${t}" class="form-check-input me-2"> <span>${t}</span></label>`; 
    });
    inputHtml += '</div>';
  } else {
    // Render Text Input
    inputHtml = `<input type="text" class="form-control answer-input" id="ansInput" autocomplete="off" autofocus placeholder="Enter answer">`;
  }

  card.innerHTML = `
    <div class="card-body p-4">
      <h5 class="card-title text-secondary mb-3">
        ${inSkippedPhase ? '<span class="badge bg-warning text-dark me-2">Skipped Question</span>' : ''}
        Question ${inSkippedPhase ? '(Review)' : (allQuestionsMasterList.findIndex(x=>x.code===q.code)+1)}
      </h5>
      ${questionDiv.outerHTML}
      <div class="options-block-sep">
        ${inputHtml}
      </div>
      <div class="d-flex gap-2 mt-3 align-items-center">
        <button class="btn btn-accent flex-grow-1" id="submitBtn">Submit</button>
        <button class="btn btn-secondary btn-skip" id="skipBtn">Skip</button>
      </div>
    </div>
  `;
  examQuiz.appendChild(card);
  setTimeout(() => card.classList.add('show'), 10);

  // Wire focus and draft saving for text inputs
  const ansInput = document.getElementById('ansInput');
  if (ansInput) {
    ansInput.addEventListener('focus', () => { card.scrollIntoView({behavior: 'smooth', block: 'center'}); });
    ansInput.addEventListener('input', () => {
      ansInput.style.height = 'auto';
      ansInput.style.height = (ansInput.scrollHeight) + 'px';
      // save draft per question
      const q = questions[current];
      if (q) {
        const drafts = JSON.parse(localStorage.getItem('exam_drafts_v1') || '{}');
        drafts[q.code] = ansInput.value;
        localStorage.setItem('exam_drafts_v1', JSON.stringify(drafts));
      }
    });
    // restore draft if exists
    setTimeout(() => { 
        try { 
            const drafts = JSON.parse(localStorage.getItem('exam_drafts_v1') || '{}'); 
            const q = questions[current]; 
            if (q && drafts[q.code]) { 
                ansInput.value = drafts[q.code]; 
                ansInput.style.height = 'auto'; 
                ansInput.style.height = (ansInput.scrollHeight) + 'px'; 
            } 
        } catch(e){}; 
        ansInput.focus(); 
    }, 120);
  }

  // Start question timer (unless global timer is forcing)
  if (!isGlobalTimerActive) {
    if (q.timerSeconds) startTimerForQuestionWithRemaining(q.remaining || q.timerSeconds);
    else startTimerForQuestion();
  }

  // Attach Submit Event
  const submitBtnEl = document.getElementById('submitBtn');
  if (submitBtnEl) {
    submitBtnEl.addEventListener('click', () => {
      let ans = '-';
      const radio = examQuiz.querySelector('input[type="radio"]:checked');
      if (radio) ans = radio.value.trim();
      else if (ansInput) ans = ansInput.value.trim() || '-';
      
      // Confirm and submit locally
      showConfirmModal(ans, () => { submitAnswer(ans); });
    });
  }

  // Attach Skip Event
  const skipBtn = document.getElementById('skipBtn');
  if (skipBtn) {
    // remove skip button during skipped-phase (students can only skip once)
    if (inSkippedPhase) skipBtn.remove();
    else skipBtn.addEventListener('click', () => { markSkipForCurrent(); });
  }
  
  // Handle Enter key for text inputs
  if (ansInput) {
    ansInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitBtnEl.click();
      }
    };
  }
}

// small helper to escape HTML for title attributes
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function finishExam(reason) {
  clearInterval(timer); isExamActive = false; examQuiz.innerHTML = '';
  updateHudEl(examProgressEl, 'Exam Completed');
  const resultsCard = document.createElement('div'); resultsCard.className = 'card card-custom mx-auto fade-in';
  resultsCard.style.maxWidth = '600px';
  resultsCard.innerHTML = `
    <div class="card-body text-center">
      <h2 class="card-title">Exam Completed</h2>
      <div id="submissionStatus" class="mt-3 fs-6 text-muted">Submitting answers...</div>
    </div>
  `;
  examQuiz.appendChild(resultsCard); setTimeout(() => resultsCard.classList.add('show'), 10);

  // Prepare final FM payload: F..M = lastName, firstName, score, correct, mistakes, startTime, endTime, date
  userInfo.endTime = new Date().toISOString(); userInfo.date = userInfo.endTime.split('T')[0];
  // compute total based on initial count if present
  let savedInitial = initialTotalCount || totalQuestionCount || 0;
  try { const s = sessionStorage.getItem('exam_initial_total_v1'); if (!savedInitial && s) savedInitial = parseInt(s, 10) || savedInitial; } catch(e){}
  const totalForSummary = savedInitial || questions.length || 0;
  // Compute correct and mistakes lists from local answersMap
  const allCodes = Object.keys(answersMap || {});
  const correctList = [];
  const mistakesList = [];
  allCodes.forEach((c) => {
    const ua = String((userAnswers || {})[c] || '').trim();
    const ca = String((answersMap || {})[c] || '').trim();
    if (!ua) return;
    if (ua && ca && ua.toLowerCase() === ca.toLowerCase()) correctList.push(`${c} ${ua}`);
    else if (ua && ua !== '-') mistakesList.push(`${c} ${ua}`);
  });
  const statusEl = resultsCard.querySelector('#submissionStatus');
  const fmPayload = {
    action: 'recordResultsFM',
    lastName: userInfo.lastName,
    firstName: userInfo.firstName,
    code: userInfo.code,
    score: `${score}/${totalForSummary}`,
    correct: correctList.join(', '),
    mistakes: mistakesList.join(', '),
    startTime: userInfo.startTime,
    endTime: userInfo.endTime,
    date: userInfo.date
  };
  // Force immediate submission with continuous retry until success
  async function postWithRetry() {
    while (true) {
      if (!isOnline()) {
        statusEl.textContent = 'Waiting for internet connection...';
        statusEl.classList.remove('text-success'); statusEl.classList.add('text-warning');
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      try {
        const res = await fetch(apiUrl(), { method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(fmPayload) });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.success) {
          statusEl.textContent = '✓ Results submitted.'; statusEl.classList.remove('text-warning'); statusEl.classList.add('text-success');
          try { localStorage.setItem('exam_submission_status_v1', 'submitted'); } catch(e) {}
          return;
        }
        statusEl.textContent = 'Server error, retrying...'; statusEl.classList.remove('text-success'); statusEl.classList.add('text-warning');
      } catch (e) {
        statusEl.textContent = 'Network error, retrying...'; statusEl.classList.remove('text-success'); statusEl.classList.add('text-warning');
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  await postWithRetry();
  // mark exam as finished so reloads won't attempt to restart
  try { sessionStorage.removeItem('exam_in_progress_v1'); } catch(e){}
  // clear any saved runtime state so reload won't attempt to resume a finished exam
  try { clearRuntimeState(); } catch(e){}
  // clear persisted behavior warnings for this session
  try { sessionStorage.removeItem('exam_behavior_warnings_v1'); behaviorWarnings = 0; } catch(e){}
  // after a short delay redirect to exit page; include violated flag if any
  setTimeout(() => {
    // Denominator: always use the original main-batch size (questions rendered in first batch)
    // This means correct answers from both the main batch and the skipped batch contribute
    // to the numerator, but the denominator remains the initial main-batch count.
  // try to read saved initial total from sessionStorage if variable is not set
  let savedInitial = initialTotalCount || totalQuestionCount || 0;
  try { const s = sessionStorage.getItem('exam_initial_total_v1'); if (!savedInitial && s) savedInitial = parseInt(s, 10) || savedInitial; } catch(e){}
  const total = savedInitial || questions.length || 0;
    const q = new URLSearchParams({ violated: userInfo.violated ? '1' : '0', score: `${score}/${total}` });
    if (reason) q.set('reason', reason);
    window.location.href = 'exit.html?' + q.toString();
  }, 600);
}

function handleViolation(message) {
  // Only warn on visibility/tab changes or window blur. Do not force fullscreen.
  if (!isExamActive || violationLock) return; violationLock = true;
  // increment persisted behavior counter
  behaviorWarnings = (behaviorWarnings || 0) + 1;
  try { sessionStorage.setItem('exam_behavior_warnings_v1', String(behaviorWarnings)); } catch (e) {}

  const wt = document.getElementById('warningText');
  // Determine behavior: first two violations are warnings with a 20s countdown; third (>=3) submits
  if (behaviorWarnings <= 2) {
    // start a 20 second countdown that will auto-resume the exam
    warningCountdownRemaining = 20;
    if (wt) wt.textContent = message || `Behavior warning ${behaviorWarnings}/2: You switched away or performed a disallowed action. Resuming in ${warningCountdownRemaining}s...`;
    if (warningModal) warningModal.show();
    // clear any previous interval
    if (warningCountdownInterval) { clearInterval(warningCountdownInterval); warningCountdownInterval = null; }
    warningCountdownInterval = setInterval(() => {
      warningCountdownRemaining--;
      if (wt) wt.textContent = message || `Behavior warning ${behaviorWarnings}/2: Resuming in ${warningCountdownRemaining}s...`;
      if (warningCountdownRemaining <= 0) {
        clearInterval(warningCountdownInterval); warningCountdownInterval = null;
        try { if (warningModal) warningModal.hide(); } catch(e){}
        // resume exam
        violationLock = false;
      }
    }, 1000);
    // small window to clear initial lock (allow other events after a short pause)
    setTimeout(() => { violationLock = false; }, 800);
  } else {
    // third (or more) violation -> inform user then submit
    if (warningModal) {
      if (wt) wt.textContent = message || 'Third violation detected: your exam will be submitted and session ended. Contact your instructor for disputes.';
      warningModal.show();
      // mark violated flag so exit page can render accordingly
      userInfo.violated = true;
      // wait a short moment for user to read, then finish
      setTimeout(() => { warningModal.hide(); finishExam('Third violation: disallowed behavior (multiple infractions)'); violationLock = false; }, 2500);
    } else { userInfo.violated = true; finishExam('Third violation: disallowed behavior (multiple infractions)'); violationLock = false; }
  }
}

document.addEventListener('visibilitychange', () => { if (document.hidden) handleViolation(); });
// also treat window blur as a potential violation (Alt+Tab or switching application)
window.addEventListener('blur', () => { if (document.hasFocus && !document.hasFocus()) handleViolation(); });

// Prevent right-click context menu globally during the exam to deter copying/searching,
// but allow context menu on input and textarea elements for accessibility when needed.
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // allow on editable fields
  // if exam is active, block context menu
  if (isExamActive) {
    e.preventDefault();
  }
});

// Back-button / popstate handling: prevent accidental navigation via Back button.
// We push a history state when the exam initializes and listen for popstate; when triggered
// show the same warningModal but do NOT increment tabWarnings or treat it as a violation.
let popStateGuardInstalled = false;
function installBackButtonGuard() {
  if (popStateGuardInstalled) return;
  try {
    // push an extra state so Back button fires popstate we can intercept
    history.pushState({ exam: 'running' }, document.title, location.href);
    popStateGuardInstalled = true;
  } catch (e) {
    // ignore environments that disallow pushState
    popStateGuardInstalled = false;
  }

  window.addEventListener('popstate', (ev) => {
    // If exam active and user tries to navigate back, count as a behavior violation
    if (!isExamActive) return; // allow normal navigation when not active
    // mark that this popstate was a back-nav so continue will re-push state
    window._lastPopStateWasBackNav = true;
    // treat back navigation as a violation and show the warning modal via handleViolation
    handleViolation('Back navigation detected: leaving the exam will be counted as a behavior warning.');
    // re-push the state so user stays on the page if they choose Continue
    try { history.pushState({ exam: 'running' }, document.title, location.href); } catch(e){}
  });
}

// Prevent text selection globally to deter copy-search but allow inputs
document.addEventListener('selectstart', (e) => { const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; e.preventDefault(); });

// Detect screenshot keys (Windows PrintScreen, macOS CMD+Shift+3/4 via key detection limited)
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  // PrintScreen key
  if (k === 'printscreen') { showScreenshotViolation(); }
  // Common combinations
  if ((e.ctrlKey && e.key === 's') || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); }
});

function showScreenshotViolation() { if (!isExamActive) return; if (warningModal) { document.getElementById('warningText').textContent = 'Screenshot detected. This is a violation.'; warningModal.show(); } }

// Detect significant window resize (possible multi-app split)
// NOTE: Disabled on mobile devices due to virtual keyboard and in-app browser UI interference
let lastSize = { w: window.innerWidth, h: window.innerHeight };
window.addEventListener('resize', () => {
  // Skip resize violation check on mobile devices (keyboard, toolbar changes trigger false positives)
  if (IS_MOBILE_DEVICE) return;
  
  const w = window.innerWidth, h = window.innerHeight;
  const dw = Math.abs(w - lastSize.w), dh = Math.abs(h - lastSize.h);
  lastSize = { w, h };
  if (isExamActive && (dw > 200 || dh > 200)) {
    // Treat large resize as a behavior violation (desktop only)
    handleViolation('Screen size changed: this is considered a violation.');
  }
});

/* ------------------ Modal Buttons: Continue / Exit ------------------ */
const continueBtn = document.getElementById('continueBtn');
const exitBtn = document.getElementById('exitBtn');

if (continueBtn) {
  continueBtn.addEventListener('click', async () => {
    // stop countdown and resume immediately
    if (warningCountdownInterval) { clearInterval(warningCountdownInterval); warningCountdownInterval = null; }
    warningCountdownRemaining = 0;
    if (warningModal) warningModal.hide();
    try { await requestFullscreen(); } catch (e) { /* ignore */ }
    // small delay to avoid duplicate triggers
    setTimeout(() => { 
      // if this modal was from a Back navigation, re-push state to prevent immediate back
      if (window._lastPopStateWasBackNav) {
        try { history.pushState({ exam: 'running' }, document.title, location.href); } catch(e){}
        window._lastPopStateWasBackNav = false;
      }
      // If there is a saved runtime state, attempt to resume using startExam
      try {
        const rs = sessionStorage.getItem('exam_runtime_state_v1');
        if (rs && !isExamActive) {
          // parse the last known user info from URL params
          const params = new URLSearchParams(location.search);
          const lastName = params.get('lastName');
          const firstName = params.get('firstName');
          const code = params.get('code');
          if (lastName && firstName && code) {
            startExam(lastName, firstName, code);
            violationLock = false;
            return;
          }
        }
      } catch (e) { /* ignore */ }
      violationLock = false;
    }, 150);
  });
}

if (exitBtn) {
  exitBtn.addEventListener('click', async () => {
    // Attempt to record a partial/aborted submission, else queue it.
    try {
      const payload = {
        action: 'recordPartial',
        lastName: userInfo.lastName || '',
        firstName: userInfo.firstName || '',
        code: userInfo.code || '',
        submittedAnswers: JSON.stringify(userAnswers || {}),
        status: 'aborted',
        timestamp: new Date().toISOString()
      };

      if (isOnline()) {
        try {
          const res = await fetch(apiUrl(), { method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams(payload) });
          if (!res.ok) {
            // queue for later if server returns error
            pushOfflineQueue(payload);
          }
        } catch (err) {
          // network or other failure: queue for later
          pushOfflineQueue(payload);
        }
      } else {
        // offline: queue for later submission
        pushOfflineQueue(payload);
      }
    } catch (e) {
      console.error('Exit handling failed:', e);
    }

    // Clean up drafts and local transient state
    try { localStorage.removeItem('exam_drafts_v1'); } catch (e) {}

    // Redirect to exit page
    // clear back-nav marker if present
    try { window._lastPopStateWasBackNav = false; } catch(e){}
    window.location.href = 'exit.html';
  });
}

// Utility
function shuffleArray(arr) { for (let i = arr.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]];} return arr; }

// Initialize or resume the exam. This is callable from the reload modal Continue button
async function startExam(lastName, firstName, code) {
  try {
    userInfo.lastName = lastName; userInfo.firstName = firstName; userInfo.code = code; userInfo.startTime = userInfo.startTime || new Date().toISOString(); userInfo.date = userInfo.startTime.split('T')[0];
    isExamActive = true;
    // mark session in progress to avoid accidental reloads re-initializing
    try { sessionStorage.setItem('exam_in_progress_v1', '1'); } catch (e) {}
    // Show loading, fetch batch, enforce fullscreen after batch load
    if (examLoading) { examLoading.classList.remove('d-none'); const el = document.getElementById('examLoadingCode'); if (el) el.textContent = userInfo.code; }
    const ok = await fetchAllQuestionsAndAnswers();
    if (examLoading) examLoading.classList.add('d-none');
    if (!ok) { isExamActive = false; return; }
    // Attempt to restore runtime state (current index, remaining seconds, user answers)
    try {
      const rs = sessionStorage.getItem('exam_runtime_state_v1');
      if (rs) {
        const st = JSON.parse(rs);
        // Verify that the stored question set matches by code length or other heuristics
        if (st && typeof st.current === 'number' && Array.isArray(st.questions) && st.questions.length) {
          // Use stored questions only if codes match the freshly loaded questions count or codes set
          // We'll attempt to align by question codes: if codes match, restore current and remaining
          const loadedCodes = questions.map(q => q.code).join('|');
          const storedCodes = st.questions.map(q => q.code).join('|');
          if (loadedCodes === storedCodes) {
            current = st.current || 0;
            userAnswers = st.userAnswers || {};
            // restore skippedBatch if present
            if (Array.isArray(st.skippedBatch)) { skippedBatch = st.skippedBatch; saveSkippedBatch(); }
            // render and restore remaining seconds
            renderQuestion(current);
            if (typeof st.remaining === 'number') startTimerForQuestionWithRemaining(st.remaining);
            // already resumed
            return;
          }
        }
      }
    } catch (e) { console.warn('Failed to restore runtime state', e); }
    // Install the Back-button (popstate) guard so Back shows a modal and prevents accidental exit
    try { installBackButtonGuard(); } catch (e) { /* ignore */ }
    // Force fullscreen after load (no-op kept)
    try { await requestFullscreen(); } catch (e) {}
    current = 0; score = 0; userAnswers = {};
    renderQuestion(0);
  } catch (e) { console.error('startExam failed', e); }
}

// Save runtime state so reload can resume exactly where student left off
function saveRuntimeState() {
  try {
    const state = {
      current: current,
      remaining: remaining,
      questions: questions.map(q => ({ code: q.code, question: q.question, timerSeconds: q.timerSeconds })),
      userAnswers: userAnswers,
      skippedBatch: skippedBatch
    };
    sessionStorage.setItem('exam_runtime_state_v1', JSON.stringify(state));
  } catch (e) { console.warn('saveRuntimeState failed', e); }
}

// Clear runtime state when exam finishes or user explicitly exits
function clearRuntimeState() {
  try { sessionStorage.removeItem('exam_runtime_state_v1'); } catch(e){}
}

// Save runtime state on page unload so reload/resume can restore
// Intercept beforeunload: save runtime and treat unload (reload/close) as a behavior violation.
window.addEventListener('beforeunload', (e) => {
  try { if (isExamActive) saveRuntimeState(); } catch(e){}
  if (isExamActive) {
    // Count this as a behavior violation and prompt the user to confirm navigation.
    try { handleViolation('Reload or close detected: leaving the exam will be counted as a behavior warning.'); } catch(e){}
    // Standard way to trigger the browser's leave-confirm dialog
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

// Block common reload keyboard shortcuts (F5, Ctrl+R / Cmd+R) while exam is active
document.addEventListener('keydown', (e) => {
  if (!isExamActive) return;
  const key = e.key;
  if (key === 'F5' || ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'r')) {
    e.preventDefault();
    handleViolation('Reload key detected: this is a behavior warning.');
  }
  // Optionally block Ctrl+W (close tab) if you want to discourage closing
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'w') {
    e.preventDefault();
    handleViolation('Attempt to close tab detected: this is a behavior warning.');
  }
});

// Entry: parse query params and initialize exam
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(location.search);
  const lastName = params.get('lastName');
  const firstName = params.get('firstName');
  const code = params.get('code');
  // Basic validation: require user info in query params
  if (!lastName || !firstName || !code) {
    alert('Missing user info. Return to login.'); location.href = 'index.html'; return;
  }

  // reload-prevention: if exam_in_progress_v1 present, show reload modal and allow the user
  // to CONTINUE the exam (resume) or EXIT the exam (submit/abort). Continue will resume
  // the same in-progress session instead of returning to the login page.
  const inProg = sessionStorage.getItem('exam_in_progress_v1');
  if (inProg && inProg === '1') {
    // Use the shared warning modal to warn the user about reloading and provide Continue/Exit.
    // This counts as a behavior violation event.
    handleViolation('Reload detected: continuing will resume your in-progress exam. Exiting will submit/abort.');
    // When the user clicks Continue (warning modal's continueBtn), resume will occur via that handler.
    return;
  }
  if (!lastName || !firstName || !code) {
    alert('Missing user info. Return to login.'); location.href = 'index.html'; return;
  }
  // Start (fresh) exam initialization (delegated to startExam so reload-resume can reuse it)
  await startExam(lastName, firstName, code);
});

// Initialize the Modal
const skippedModal = new bootstrap.Modal(document.getElementById('skippedModal'));
const skippedListEl = document.getElementById('skippedList');

function showSkippedQuestions() {
    const skippedListEl = document.getElementById('skippedList');
    if (!skippedListEl) return;
    skippedListEl.innerHTML = ''; 

    // 1. Check if there are actually any skipped questions
    if (skippedBatch.length === 0) {
        skippedListEl.innerHTML = '<p class="text-center p-3 text-muted">No skipped questions pending.</p>';
        skippedModal.show();
        return;
    }

    // 2. Create the list
    const listGroup = document.createElement('div');
    listGroup.className = 'list-group';

    skippedBatch.forEach((q, index) => {
        const btn = document.createElement('button');
        btn.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
        
        // Format the text (remove HTML tags for clean display)
        const plainText = q.question.replace(/<[^>]*>/g, '').substring(0, 60) + '...';
        
        btn.innerHTML = `
            <div>
                <strong>${q.code}</strong>
                <div class="small text-muted">${plainText}</div>
            </div>
            <span class="badge bg-primary rounded-pill">Answer Now</span>
        `;

        // 3. The "Click to Answer" Logic
        btn.onclick = () => {
            // A. Remove this specific question from the skipped batch
            const retrievedQ = skippedBatch.splice(index, 1)[0];
            saveSkippedBatch(); // Update storage

            // B. Ensure the timer respects the time they had left (prevent cheating)
            // We map 'remaining' back to 'timerSeconds' so they resume with their saved time
            if (retrievedQ.remaining) {
                retrievedQ.timerSeconds = retrievedQ.remaining;
            }

            // C. Insert the question back into the ACTIVE exam array at the CURRENT position
            // This pushes the current question down by 1 and places the skipped one in front
            questions.splice(current, 0, retrievedQ);

            // D. Render the retrieved question immediately
            renderQuestion(current);

            // E. Update the skipped count in the HUD
            const sq = document.getElementById('skippedPill');
            if(sq) sq.textContent = `Check Skipped Questions ${skippedBatch.length}`;

            // F. Close the modal
            skippedModal.hide();
        };

        listGroup.appendChild(btn);
    });

    skippedListEl.appendChild(listGroup);
    skippedModal.show();
}

// Navigation: Move to the previous question
function prevQuestion() {
  if (current > 0) {
    current--;
    visitedQuestions.add(current); // Track the question as visited
    renderQuestion(current);
  }
}
// Function to navigate to a specific question
function jumpToQuestion(index) {
    current = index; // Update the current question pointer
    renderQuestion(current); // Re-render the UI
}

// Attach to your "Skipped" HUD pill or button
document.addEventListener('DOMContentLoaded', () => {
    const skippedBtn = document.getElementById('skippedPill');
    if (skippedBtn) {
        skippedBtn.onclick = (e) => {
            e.preventDefault();
            showSkippedQuestions(); // Call your function here
        };
    }
});
