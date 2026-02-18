/* exam.js - COMPLETE CODE with Fullscreen Enforcement + Violation Logging + V2 Skipped Logic + FIXED COUNTERS */

// Fallback API URL (kept for backwards-compatibility)
const FALLBACK_ANSWER_API_URL = "https://script.google.com/macros/s/AKfycby6B9OgDmMNJqGmDNBvF7MJnAaV1wXTnvmzjjCEqn8vIh1zEFx7Izn3jxEJIsvnuXF4/exec";
// Next.js API URL for violation logging to dashboard
const NEXTJS_API_URL = window.NEXTJS_API_URL || '';

/* ========== FULLSCREEN HELPERS ========== */
function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  if (el.msRequestFullscreen) return el.msRequestFullscreen();
  return Promise.resolve();
}

function inFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement ||
            document.mozFullScreenElement || document.msFullscreenElement);
}

function exitFullscreen() {
  if (document.exitFullscreen) return document.exitFullscreen();
  if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
  if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  if (document.msExitFullscreen) return document.msExitFullscreen();
  return Promise.resolve();
}

/* ========== EXTERNAL SCRIPT DETECTION ========== */
let detectedScriptsCache = [];

function detectExternalScripts() {
  const scripts = document.querySelectorAll('script[src]');
  const publicScriptPattern = /public\/scripts\//i;
  const detectedScripts = [];
  
  scripts.forEach((script) => {
    const src = script.src || '';
    if (publicScriptPattern.test(src)) {
      const found = detectedScriptsCache.find(s => s.src === src);
      if (!found) {
        detectedScripts.push({
          src: src,
          async: script.async,
          defer: script.defer,
          type: script.type,
          integrity: script.integrity
        });
      }
    }
  });
  
  return detectedScripts;
}

function logExternalScriptViolation(scripts) {
  if (scripts && scripts.length > 0) {
    scripts.forEach((script) => {
      if (!detectedScriptsCache.find(s => s.src === script.src)) {
        detectedScriptsCache.push(script);
      }
      const message = `External script detected: ${script.src}`;
      console.warn('[VIOLATION]', message);
      handleViolation(message, 'EXTERNAL_SCRIPT');
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const externalScripts = detectExternalScripts();
  if (externalScripts.length > 0) {
    console.warn('[VIOLATION] External scripts detected at initialization:', externalScripts);
    logExternalScriptViolation(externalScripts);
  }
});

let scriptMonitorInterval = null;
function startExternalScriptMonitoring() {
  if (scriptMonitorInterval) clearInterval(scriptMonitorInterval);
  scriptMonitorInterval = setInterval(() => {
    if (isExamActive) {
      const externalScripts = detectExternalScripts();
      if (externalScripts.length > 0) {
        console.warn('[VIOLATION] External scripts detected during exam:', externalScripts);
        logExternalScriptViolation(externalScripts);
      }
    }
  }, 5000);
}

function stopExternalScriptMonitoring() {
  if (scriptMonitorInterval) {
    clearInterval(scriptMonitorInterval);
    scriptMonitorInterval = null;
  }
}

/* ========== EXAM STATE VARIABLES ========== */
let allQuestionsMasterList = [];
let visitedQuestions = new Set();
let examGlobalTimerSeconds = null;
let isGlobalTimerActive = false;
let globalTimerInterval = null;

function apiUrl() {
  try {
    if (typeof window !== 'undefined' && window.ANSWER_API_URL) return window.ANSWER_API_URL;
  } catch (e) {}
  return FALLBACK_ANSWER_API_URL;
}

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
let behaviorWarnings = 0;
try { behaviorWarnings = parseInt(sessionStorage.getItem('exam_behavior_warnings_v1') || '0', 10) || 0; } catch (e) { behaviorWarnings = 0; }
let isExamActive = false;
let violationLock = false;
let confirmOpen = false;
let warningCountdownInterval = null;
let warningCountdownRemaining = 0;

let skippedBatch = [];
let inSkippedPhase = false;

function isMobileDevice() {
  const userAgent = navigator.userAgent || navigator.vendor || window.opera;
  const mobileRegex = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i;
  const isSmallScreen = window.innerWidth < 768;
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  return mobileRegex.test(userAgent) || (isSmallScreen && isTouchDevice);
}

const IS_MOBILE_DEVICE = isMobileDevice();

console.log(`Device detected as: ${IS_MOBILE_DEVICE ? 'MOBILE' : 'DESKTOP'}`);
console.log(`Screen size: ${window.innerWidth}x${window.innerHeight}`);
console.log(`User agent: ${navigator.userAgent}`);

function saveSkippedBatch() {
  try { localStorage.setItem('exam_skipped_batch_v1', JSON.stringify(skippedBatch)); } catch (e) { console.warn('save skipped batch failed', e); }
}

function loadSkippedBatch() {
  try { skippedBatch = JSON.parse(localStorage.getItem('exam_skipped_batch_v1') || '[]'); } catch (e) { skippedBatch = []; }
}

loadSkippedBatch();

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
        const currentQ = getOfflineQueue();
        currentQ.shift();
        localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(currentQ));
      } else break;
    } catch (e) { break; }
  }
}

window.addEventListener('online', () => { flushOfflineQueue(); });

const examQuiz = document.getElementById('examQuiz');
const examProgressEl = document.getElementById('examProgress');
const examTimerEl = document.getElementById('examTimer');

let totalQuestionCount = 0;
let initialTotalCount = 0;

// Try to recover initial total from storage on load
try {
  const savedTotal = sessionStorage.getItem('exam_initial_total_v1');
  if (savedTotal) {
    initialTotalCount = parseInt(savedTotal, 10);
    totalQuestionCount = initialTotalCount;
  }
} catch(e) {}

function isOnline() { return navigator.onLine; }

function normalizeCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  const mQ = s.match(/^Q0*(\d+)$/);
  if (mQ) return 'Q' + ('000' + mQ[1]).slice(-3);
  const mN = s.match(/^0*(\d+)$/);
  if (mN) return 'Q' + ('000' + mN[1]).slice(-3);
  return s;
}

function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return m + ':' + sec;
}

function updateHudEl(el, text) {
  if (el) { el.textContent = text; el.classList.add('updated'); setTimeout(() => el.classList.remove('updated'), 600); }
}

function getFixedTotal() {
  // Helper to ensure denominator never shrinks
  if (initialTotalCount && initialTotalCount > 0) return initialTotalCount;
  try {
    const s = sessionStorage.getItem('exam_initial_total_v1');
    if (s) {
      initialTotalCount = parseInt(s, 10);
      return initialTotalCount;
    }
  } catch(e){}
  // Fallback if not yet set
  return questions.length + skippedBatch.length + Object.keys(userAnswers).length;
}

function startGlobalCountdown() {
  if (!examGlobalTimerSeconds || examGlobalTimerSeconds <= 0) return;
  let globalRemaining = examGlobalTimerSeconds;
  updateHudEl(examTimerEl, `Exam Time: ${formatTime(globalRemaining)}`);
  
  if (globalTimerInterval) clearInterval(globalTimerInterval);
  globalTimerInterval = setInterval(() => {
    globalRemaining--;
    updateHudEl(examTimerEl, `Exam Time: ${formatTime(globalRemaining)}`);
    if (globalRemaining <= 0) {
      clearInterval(globalTimerInterval);
      globalTimerInterval = null;
      finishExam('Global exam time expired');
    }
  }, 1000);
}

function startTimerForQuestion() {
  clearInterval(timer);
  remaining = examTimerSeconds;
  updateHudEl(examTimerEl, `Time: ${formatTime(remaining)}`);
  timer = setInterval(() => {
    remaining--;
    updateHudEl(examTimerEl, `Time: ${formatTime(remaining)}`);
    if (remaining <= 0) {
      clearInterval(timer);
      autoSubmitAnswer();
    }
  }, 1000);
}

function startTimerForQuestionWithRemaining(r) {
  clearInterval(timer);
  remaining = Math.max(1, r || examTimerSeconds);
  updateHudEl(examTimerEl, `Time: ${formatTime(remaining)}`);
  timer = setInterval(() => {
    remaining--;
    updateHudEl(examTimerEl, `Time: ${formatTime(remaining)}`);
    if (remaining <= 0) {
      clearInterval(timer);
      autoSubmitAnswer();
    }
  }, 1000);
}

function autoSubmitAnswer() {
  const ansInput = document.getElementById('ansInput');
  const ans = ansInput ? ansInput.value.trim() || '-' : '-';
  submitAnswer(ans);
}

function submitAnswer(ans) {
  clearInterval(timer);
  const q = questions[current];
  if (!q) return;
  
  visitedQuestions.add(q.code);
  userAnswers[q.code] = ans;
  
  try {
    const drafts = JSON.parse(localStorage.getItem('exam_drafts_v1') || '{}');
    delete drafts[q.code];
    localStorage.setItem('exam_drafts_v1', JSON.stringify(drafts));
  } catch(e){}

  // 3. Remove from skipped batch if applicable (V1 PARITY FIX)
  const sbIndex = skippedBatch.findIndex(s => s.code === q.code);
  if (sbIndex !== -1) {
    skippedBatch.splice(sbIndex, 1);
    saveSkippedBatch();
    const sqUp = document.getElementById('skippedPill');
    if (sqUp) sqUp.textContent = `Check Skipped Questions ${skippedBatch.length}`;
  }

  const correctAns = String(answersMap[q.code] || '').trim();
  const userAns = String(ans || '').trim();
  
  if (userAns && correctAns && userAns.toLowerCase() === correctAns.toLowerCase()) {
    score++;
  }

  // --- UPDATED HUD LOGIC (V1 Style Stability) ---
  const answeredCount = Object.keys(userAnswers).length;
  updateHudEl(examProgressEl, `Questions ${answeredCount}/${getFixedTotal()}`);

  const sqEl = document.getElementById('skippedPill');
  if (sqEl) sqEl.textContent = `Check Skipped Questions ${skippedBatch.length}`;

  current++;
  
  if (current < questions.length) {
    renderQuestion(current);
    return;
  }

  if (skippedBatch.length > 0) {
    setTimeout(() => {
      // Logic for transitioning to skipped phase
      const initialTotal = initialTotalCount || totalQuestionCount;
      const appended = skippedBatch.map(s => ({
        code: s.code,
        question: s.question,
        timerSeconds: s.remaining || s.timerSeconds
      }));
      
      questions = appended;
      // Preserve total count
      totalQuestionCount = initialTotal || questions.length;
      
      skippedBatch = [];
      saveSkippedBatch();
      inSkippedPhase = true;

      // Update HUD immediately upon phase change
      const currentAnswered = Object.keys(userAnswers).length;
      updateHudEl(examProgressEl, `Questions ${currentAnswered}/${getFixedTotal()}`);

      const sqEl = document.getElementById('skippedPill');
      if(sqEl) sqEl.textContent = `Check Skipped Questions 0/${questions.length}`;
      
      current = 0;
      renderQuestion(0);
    }, 600);
    return;
  }

  finishExam();
}

function showConfirmModal(ans, onConfirm) {
  if (!confirmModal) { onConfirm(); return; }
  confirmOpen = true;
  const ct = document.getElementById('confirmText');
  if (ct) ct.textContent = `Submit answer: "${ans}"?`;
  confirmModal.show();

  const yesBtn = document.getElementById('confirmYes');
  const noBtn = document.getElementById('confirmNo');

  const handleYes = () => {
    confirmModal.hide();
    confirmOpen = false;
    onConfirm();
    cleanup();
  };

  const handleNo = () => {
    confirmModal.hide();
    confirmOpen = false;
    cleanup();
  };

  const cleanup = () => {
    if (yesBtn) yesBtn.removeEventListener('click', handleYes);
    if (noBtn) noBtn.removeEventListener('click', handleNo);
  };

  if (yesBtn) yesBtn.addEventListener('click', handleYes, { once: true });
  if (noBtn) noBtn.addEventListener('click', handleNo, { once: true });
}

function renderQuestion(index) {
  if (!examQuiz) return;
  examQuiz.innerHTML = '';
  const q = questions[index];
  if (!q) return;

  visitedQuestions.add(q.code);
  
  // --- UPDATED HUD LOGIC (V1 Style Stability) ---
  const answeredCount = Object.keys(userAnswers).length;
  updateHudEl(examProgressEl, `Questions ${answeredCount}/${getFixedTotal()}`);

  // Update Skipped Pill (Ensure pill stays accurate on reload/render)
  const sqEl = document.getElementById('skippedPill'); 
  if (sqEl) sqEl.textContent = `Check Skipped Questions ${skippedBatch.length}`;

  const card = document.createElement('div');
  card.className = 'card card-custom mx-auto fade-in' + (inSkippedPhase ? ' skipped-phase' : '');

  const questionDiv = document.createElement('div');
  questionDiv.className = 'question-text';
  questionDiv.innerHTML = q.question;

  // Determine Answer HTML Type (True/False, MCQ, or Text)
  const qLower = String(q.question || '').toLowerCase();
  const hasOptions = qLower.includes('a.') || qLower.includes('b.') || qLower.includes('c.') || qLower.includes('d.');
  const isTrueFalse = qLower.includes('true') && qLower.includes('false');

  let answerHtml = '';
  if (isTrueFalse) {
    answerHtml = `
      <div class="tf-options">
        <label class="tf-btn">
          <input type="radio" name="tfChoice" value="True">
          <span>True</span>
        </label>
        <label class="tf-btn">
          <input type="radio" name="tfChoice" value="False">
          <span>False</span>
        </label>
      </div>
    `;
  } else if (hasOptions) {
    answerHtml = `
      <div class="mcq-inline">
        <label class="mcq-btn">
          <input type="radio" name="mcqChoice" value="A">
          <span class="mcq-letter">A</span>
        </label>
        <label class="mcq-btn">
          <input type="radio" name="mcqChoice" value="B">
          <span class="mcq-letter">B</span>
        </label>
        <label class="mcq-btn">
          <input type="radio" name="mcqChoice" value="C">
          <span class="mcq-letter">C</span>
        </label>
        <label class="mcq-btn">
          <input type="radio" name="mcqChoice" value="D">
          <span class="mcq-letter">D</span>
        </label>
      </div>
    `;
  } else {
    answerHtml = `<textarea class="form-control answer-input" id="ansInput" rows="3" autocomplete="off" placeholder="Type your answer here..."></textarea>`;
  }

  // --- MODIFIED V2 CARD STRUCTURE (Adds Skipped Badge and Question Number) ---
  card.innerHTML = `
    <div class="card-body p-4">
      <h5 class="card-title text-secondary mb-3">
        ${inSkippedPhase ? '<span class="badge bg-warning text-dark me-2">Skipped Question</span>' : ''}
        Question ${inSkippedPhase ? '(Review)' : (allQuestionsMasterList.findIndex(x=>x.code===q.code)+1)}
      </h5>
      ${questionDiv.outerHTML}
      ${answerHtml}
      <div class="d-flex gap-2 mt-3">
        <button class="btn btn-accent flex-grow-1" id="submitBtn">Submit Answer</button>
        <button class="btn btn-secondary btn-skip" id="skipBtn">Skip</button>
      </div>
    </div>
  `;
  // --------------------------------------------------------------------------

  examQuiz.appendChild(card);
  setTimeout(() => card.classList.add('show'), 10);

  const ansInput = document.getElementById('ansInput');
  if (ansInput) {
    ansInput.addEventListener('input', () => {
      ansInput.style.height = 'auto';
      ansInput.style.height = (ansInput.scrollHeight) + 'px';
      try {
        const drafts = JSON.parse(localStorage.getItem('exam_drafts_v1') || '{}');
        drafts[q.code] = ansInput.value;
        localStorage.setItem('exam_drafts_v1', JSON.stringify(drafts));
      } catch(e){}
    });
    setTimeout(() => { 
        try { 
            const drafts = JSON.parse(localStorage.getItem('exam_drafts_v1') || '{}'); 
            if (drafts[q.code]) { 
                ansInput.value = drafts[q.code]; 
                ansInput.style.height = 'auto'; 
                ansInput.style.height = (ansInput.scrollHeight) + 'px'; 
            } 
        } catch(e){}; 
        ansInput.focus(); 
    }, 120);
  }

  if (!isGlobalTimerActive) {
    if (q.timerSeconds) startTimerForQuestionWithRemaining(q.remaining || q.timerSeconds);
    else startTimerForQuestion();
  }

  const submitBtnEl = document.getElementById('submitBtn');
  if (submitBtnEl) {
    submitBtnEl.addEventListener('click', () => {
      let ans = '-';
      const radio = examQuiz.querySelector('input[type="radio"]:checked');
      if (radio) ans = radio.value.trim();
      else if (ansInput) ans = ansInput.value.trim() || '-';
      
      showConfirmModal(ans, () => { submitAnswer(ans); });
    });
  }

  const skipBtn = document.getElementById('skipBtn');
  if (skipBtn) {
    if (inSkippedPhase) skipBtn.remove();
    else skipBtn.addEventListener('click', () => { markSkipForCurrent(); });
  }
  
  if (ansInput) {
    ansInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitBtnEl.click();
      }
    };
  }
}

// --- UPDATED SKIP LOGIC FROM V2 (FIXED ACCURACY) ---
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

  // --- FIXED HUD LOGIC START (V1 Style Stability) ---
  const answeredCount = Object.keys(userAnswers).length;
  updateHudEl(examProgressEl, `Questions ${answeredCount}/${getFixedTotal()}`);
  // --- FIXED HUD LOGIC END ---

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
    updateHudEl(examProgressEl, `Questions ${currentAnswered}/${getFixedTotal()}`);
    
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
  let data = null;
  try {
    const pref = sessionStorage.getItem('exam_last_server_payload');
    if (pref) {
      data = JSON.parse(pref);
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
    examTimerSeconds = data.defaultTimerSeconds || 30;
    let questionsArr = [];
    if (Array.isArray(data.questions) && data.questions.length) {
      questionsArr = data.questions.slice();
    } else if (Array.isArray(data.questionsMap) && data.questionsMap.length) {
      questionsArr = data.questionsMap.slice();
    } else if (data.questionsMap && typeof data.questionsMap === 'object' && Object.keys(data.questionsMap).length) {
      questionsArr = Object.values(data.questionsMap || {});
    }

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

    let genId = 1;
    questionsArr = questionsArr.map(q => {
      const obj = Object.assign({}, q);
      if (!obj.code || String(obj.code).trim() === '') {
        obj.code = 'Q' + String(genId++).padStart(3, '0');
      }
      obj.code = normalizeCode(obj.code) || obj.code;
      if (typeof obj.answer === 'undefined' || obj.answer === null) obj.answer = '';
      if (typeof obj.timerSeconds === 'undefined' || obj.timerSeconds === null) obj.timerSeconds = examTimerSeconds;
      return obj;
    });

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
          fullQuestions.push({ code: 'Q' + String(i).padStart(3, '0'), question: '[MISSING QUESTION ' + ('Q' + String(i).padStart(3, '0')) + ']', answer: '', timerSeconds: examTimerSeconds });
        }
      }
    } else {
      fullQuestions = questionsArr.slice();
    }

    for (let i = fullQuestions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fullQuestions[i], fullQuestions[j]] = [fullQuestions[j], fullQuestions[i]];
    }

    questions = fullQuestions.slice();
    allQuestionsMasterList = fullQuestions.slice();

    totalQuestionCount = questions.length;
    // LOCK THIS DOWN IMMEDIATELY
    initialTotalCount = questions.length;
    try { sessionStorage.setItem('exam_initial_total_v1', String(initialTotalCount)); } catch(e){}

    answersMap = {};
    questions.forEach(q => { answersMap[q.code] = q.answer; });

    console.log('Questions loaded:', questions.length);
    return true;
  } catch (err) {
    console.error('fetchAllQuestionsAndAnswers error:', err);
    if (errorModalEl) {
      const et = document.getElementById('errorText');
      if (et) et.innerHTML = `<strong>Failed to load questions:</strong><br>${err.message}<br><br><small>Check internet connection or contact instructor.</small>`;
      errorModal.show();
    }
    return false;
  }
}

async function startExam(lastName, firstName, code) {
  try {
    userInfo.lastName = lastName;
    userInfo.firstName = firstName;
    userInfo.code = code.toUpperCase();
    userInfo.startTime = new Date().toISOString();
    userInfo.date = userInfo.startTime.split('T')[0];
    
    sessionStorage.setItem('exam_in_progress_v1', '1');
    
    // FORCE FULLSCREEN IMMEDIATELY
    try {
      await requestFullscreen();
      console.log('[Fullscreen] Exam started in fullscreen mode');
    } catch (e) {
      console.warn('[Fullscreen] Failed to enter fullscreen:', e);
    }
    
    isExamActive = true;
    startExternalScriptMonitoring();

    // === AGGRESSIVE CLEANUP: Ensure we don't load "ghost" skips from previous sessions ===
    // We clear the global variable AND localStorage before fetching new questions
    skippedBatch = [];
    try { localStorage.removeItem('exam_skipped_batch_v1'); } catch(e){}
    try { localStorage.removeItem('exam_drafts_v1'); } catch(e){}
    // ===================================================================================

    const success = await fetchAllQuestionsAndAnswers();
    if (!success || !questions.length) {
      isExamActive = false;
      return;
    }

    try {
      if (sessionStorage.getItem('exam_runtime_state_v1')) {
        const st = JSON.parse(sessionStorage.getItem('exam_runtime_state_v1'));
        if (st && typeof st.current === 'number' && Array.isArray(st.questions) && st.questions.length) {
          const loadedCodes = questions.map(q => q.code).join('|');
          const storedCodes = st.questions.map(q => q.code).join('|');
          if (loadedCodes === storedCodes) {
            current = st.current || 0;
            userAnswers = st.userAnswers || {};
            if (Array.isArray(st.skippedBatch)) { skippedBatch = st.skippedBatch; saveSkippedBatch(); }
            renderQuestion(current);
            if (typeof st.remaining === 'number') startTimerForQuestionWithRemaining(st.remaining);
            return;
          }
        }
      }
    } catch (e) { console.warn('Failed to restore runtime state', e); }
    
    try { installBackButtonGuard(); } catch (e) {}
    
    current = 0; 
    score = 0; 
    userAnswers = {};
    renderQuestion(0);
  } catch (e) { 
    console.error('startExam failed', e); 
  }
}

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

function clearRuntimeState() {
  try { sessionStorage.removeItem('exam_runtime_state_v1'); } catch(e){}
}

window.addEventListener('beforeunload', (e) => {
  try { if (isExamActive) saveRuntimeState(); } catch(e){}
  if (isExamActive) {
    try { handleViolation('Reload or close detected: leaving the exam will be counted as a behavior warning.', 'PAGE_RELOAD'); } catch(e){}
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

// BLOCK RELOAD SHORTCUTS
document.addEventListener('keydown', (e) => {
  if (!isExamActive) return;
  const key = e.key;
  
  // Block F5, Ctrl+R, Cmd+R (reload)
  if (key === 'F5' || ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'r')) {
    e.preventDefault();
    handleViolation('Reload key detected: this is a behavior warning.', 'RELOAD_ATTEMPT');
  }
  
  // Block Ctrl+W, Cmd+W (close tab)
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'w') {
    e.preventDefault();
    handleViolation('Attempt to close tab detected: this is a behavior warning.', 'CLOSE_ATTEMPT');
  }
  
  // BLOCK CTRL+C (COPY)
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'c') {
    e.preventDefault();
    handleViolation('Copy attempt detected (Ctrl+C blocked).', 'COPY_ATTEMPT');
  }
  
  // BLOCK CTRL+V (PASTE)
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'v') {
    e.preventDefault();
    handleViolation('Paste attempt detected (Ctrl+V blocked).', 'PASTE_ATTEMPT');
  }
  
  // BLOCK CTRL+X (CUT)
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'x') {
    e.preventDefault();
    handleViolation('Cut attempt detected (Ctrl+X blocked).', 'CUT_ATTEMPT');
  }
});

// BLOCK COPY/PASTE/CUT EVENTS
document.addEventListener('copy', (e) => {
  if (isExamActive) {
    e.preventDefault();
    handleViolation('Copy action blocked.', 'COPY_EVENT');
  }
});

document.addEventListener('paste', (e) => {
  if (isExamActive) {
    const target = e.target;
    // Allow paste ONLY in answer input fields
    if (target && (target.id === 'ansInput' || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
      return; // Allow paste in answer fields
    }
    e.preventDefault();
    handleViolation('Paste action blocked.', 'PASTE_EVENT');
  }
});

document.addEventListener('cut', (e) => {
  if (isExamActive) {
    e.preventDefault();
    handleViolation('Cut action blocked.', 'CUT_EVENT');
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(location.search);
  const lastName = params.get('lastName');
  const firstName = params.get('firstName');
  const code = params.get('code');
  
  if (!lastName || !firstName || !code) {
    alert('Missing user info. Return to login.'); 
    location.href = 'index.html'; 
    return;
  }

  const inProg = sessionStorage.getItem('exam_in_progress_v1');
  if (inProg && inProg === '1') {
    handleViolation('Reload detected: continuing will resume your in-progress exam. Exiting will submit/abort.', 'PAGE_RELOAD');
    return;
  }
  
  await startExam(lastName, firstName, code);
});

const skippedModal = new bootstrap.Modal(document.getElementById('skippedModal'));

// --- UPDATED MODAL LOGIC FROM V2 (Click to Answer) ---
function showSkippedQuestions() {
    const skippedListEl = document.getElementById('skippedList');
    if (!skippedListEl) return;
    skippedListEl.innerHTML = ''; 

    if (skippedBatch.length === 0) {
        skippedListEl.innerHTML = '<p class="text-center p-3 text-muted">No skipped questions pending.</p>';
        skippedModal.show();
        return;
    }

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

function prevQuestion() {
  if (current > 0) {
    current--;
    visitedQuestions.add(current);
    renderQuestion(current);
  }
}

function jumpToQuestion(index) {
    current = index;
    renderQuestion(current);
}

document.addEventListener('DOMContentLoaded', () => {
    const skippedBtn = document.getElementById('skippedPill');
    if (skippedBtn) {
        skippedBtn.onclick = (e) => {
            e.preventDefault();
            showSkippedQuestions();
        };
    }
});

async function finishExam(reason) {
  clearInterval(timer); 
  isExamActive = false;
  stopExternalScriptMonitoring();
  examQuiz.innerHTML = '';
  updateHudEl(examProgressEl, 'Exam Completed');
  
  const resultsCard = document.createElement('div'); 
  resultsCard.className = 'card card-custom mx-auto fade-in';
  resultsCard.style.maxWidth = '600px';
  resultsCard.innerHTML = `
    <div class="card-body text-center">
      <h2 class="card-title">Exam Completed</h2>
      <div id="submissionStatus" class="mt-3 fs-6 text-muted">Submitting answers...</div>
    </div>
  `;
  examQuiz.appendChild(resultsCard); 
  setTimeout(() => resultsCard.classList.add('show'), 10);

  userInfo.endTime = new Date().toISOString(); 
  userInfo.date = userInfo.endTime.split('T')[0];
  
  // Use getFixedTotal helper to ensure we have the correct total count
  const totalForSummary = getFixedTotal();
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
  
  async function postWithRetry() {
    while (true) {
      if (!isOnline()) {
        statusEl.textContent = 'Waiting for internet connection...';
        statusEl.classList.remove('text-success'); 
        statusEl.classList.add('text-warning');
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      try {
        const res = await fetch(apiUrl(), { 
          method: 'POST', 
          headers: {'Content-Type': 'application/x-www-form-urlencoded'}, 
          body: new URLSearchParams(fmPayload) 
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.success) {
          statusEl.textContent = '✓ Results submitted.'; 
          statusEl.classList.remove('text-warning'); 
          statusEl.classList.add('text-success');
          try { localStorage.setItem('exam_submission_status_v1', 'submitted'); } catch(e) {}
          return;
        }
        statusEl.textContent = 'Server error, retrying...'; 
        statusEl.classList.remove('text-success'); 
        statusEl.classList.add('text-warning');
      } catch (e) {
        statusEl.textContent = 'Network error, retrying...'; 
        statusEl.classList.remove('text-success'); 
        statusEl.classList.add('text-warning');
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  
  await postWithRetry();
  
  try { sessionStorage.removeItem('exam_in_progress_v1'); } catch(e){}
  try { clearRuntimeState(); } catch(e){}
  try { sessionStorage.removeItem('exam_behavior_warnings_v1'); behaviorWarnings = 0; } catch(e){}
  
  setTimeout(() => {
    const total = getFixedTotal();
    const q = new URLSearchParams({ 
      violated: userInfo.violated ? '1' : '0', 
      score: `${score}/${total}` 
    });
    if (reason) q.set('reason', reason);
    window.location.href = 'exit.html?' + q.toString();
  }, 600);
}

// NEW: Log violation to BOTH Google Sheet AND Next.js Dashboard
async function logViolationToSheet(violationType, violationCount) {
  try {
    const currentQuestion = questions[current];
    const questionNumber = currentQuestion ? currentQuestion.code : 'N/A';
    
    // === PART 1: Send to Google Sheet ===
    const sheetPayload = {
      action: 'logViolation',
      code: userInfo.code,
      lastName: userInfo.lastName,
      firstName: userInfo.firstName,
      violationType: violationType,
      violationCount: violationCount,
      questionNumber: questionNumber,
      timestamp: new Date().toISOString()
    };
    
    fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(sheetPayload)
    }).catch(err => {
      console.warn('[Violation Log] Failed to send to Google Sheet:', err);
    });
    
    console.log('[Violation Log] Sent to Google Sheet:', sheetPayload);
    
    // === PART 2: Send to Next.js Dashboard ===
    const nextJsPayload = {
      violationType: violationType,
      description: `${violationType} - Violation #${violationCount} on ${questionNumber}`,
      severity: violationCount === 1 ? 'low' : violationCount === 2 ? 'medium' : 'high',
      studentName: `${userInfo.firstName} ${userInfo.lastName}`,
      examTitle: `${userInfo.code} Exam`,
      examId: userInfo.code,
      examSessionId: null,
      timestamp: new Date().toISOString()
    };
    
    const nextJsApiUrl = '/api/violations';  // Use relative URL always
    
    fetch(nextJsApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextJsPayload)
    }).then(response => {
      if (response.ok) {
        console.log('[Violation Log] ✓ Sent to Next.js dashboard');
      } else {
        console.warn('[Violation Log] ⚠ Next.js API returned error:', response.status);
      }
    }).catch(err => {
      console.warn('[Violation Log] ⚠ Failed to send to Next.js:', err);
    });
    
    console.log('[Violation Log] Sent to Next.js dashboard:', nextJsPayload);
    
  } catch (e) {
    console.warn('[Violation Log] Error:', e);
  }
}

// UPDATED: handleViolation with countdown for each violation
function handleViolation(message, violationType) {
  if (!isExamActive || violationLock) return; 
  violationLock = true;
  
  behaviorWarnings = (behaviorWarnings || 0) + 1;
  try { 
    sessionStorage.setItem('exam_behavior_warnings_v1', String(behaviorWarnings)); 
  } catch (e) {}

  // Update violations remaining counter in HTML
  const violationsRemainingEl = document.getElementById('violationsRemaining');
  if (violationsRemainingEl) {
    const remaining = Math.max(0, 3 - behaviorWarnings);
    violationsRemainingEl.textContent = remaining;
    if (remaining <= 1) {
      violationsRemainingEl.style.color = '#ff6b6b';
      violationsRemainingEl.style.fontWeight = 'bold';
    }
  }

  // Log violation to both systems
  logViolationToSheet(violationType || 'UNKNOWN', behaviorWarnings);

  const wt = document.getElementById('warningText');
  
  if (behaviorWarnings <= 2) {
    // START COUNTDOWN: 20 seconds
    warningCountdownRemaining = 20;
    const remaining = 3 - behaviorWarnings;
    
    if (wt) {
      wt.innerHTML = `
        <strong>${message || `Behavior warning ${behaviorWarnings}/3`}</strong><br>
        <span style="color: #ff6b6b;">Violations remaining: ${remaining}</span><br>
        <span id="countdownText" style="font-size: 1.1rem; font-weight: bold;">Resuming in ${warningCountdownRemaining}s...</span>
      `;
    }
    
    if (warningModal) warningModal.show();
    
    if (warningCountdownInterval) { 
      clearInterval(warningCountdownInterval); 
      warningCountdownInterval = null; 
    }
    
    // Update countdown every second
    warningCountdownInterval = setInterval(() => {
      warningCountdownRemaining--;
      const countdownTextEl = document.getElementById('countdownText');
      if (countdownTextEl) {
        countdownTextEl.textContent = `Resuming in ${warningCountdownRemaining}s...`;
      }
      
      if (warningCountdownRemaining <= 0) {
        clearInterval(warningCountdownInterval); 
        warningCountdownInterval = null;
        try { if (warningModal) warningModal.hide(); } catch(e){}
        violationLock = false;
        
        // FORCE BACK TO FULLSCREEN
        try {
          requestFullscreen();
          console.log('[Fullscreen] Restored fullscreen after violation');
        } catch(e) {
          console.warn('[Fullscreen] Failed to restore fullscreen:', e);
        }
      }
    }, 1000);
    
    setTimeout(() => { violationLock = false; }, 800);
  } else {
    // THIRD VIOLATION: End exam
    if (warningModal) {
      if (wt) {
        wt.innerHTML = `
          <strong>${message || 'Third violation detected'}</strong><br>
          <span style="color: #ff6b6b;">Your exam will be submitted and session ended.</span><br>
          <small>Contact your instructor for disputes.</small>
        `;
      }
      warningModal.show();
      userInfo.violated = true;
      setTimeout(() => { 
        warningModal.hide(); 
        finishExam('Third violation: disallowed behavior (multiple infractions)'); 
        violationLock = false; 
      }, 2500);
    } else { 
      userInfo.violated = true; 
      finishExam('Third violation: disallowed behavior (multiple infractions)'); 
      violationLock = false; 
    }
  }
}

// DETECT TAB SWITCH / VISIBILITY CHANGE
document.addEventListener('visibilitychange', () => { 
  if (document.hidden) handleViolation('Tab switched away', 'TAB_SWITCH'); 
});

// DETECT WINDOW BLUR
window.addEventListener('blur', () => { 
  if (document.hasFocus && !document.hasFocus()) {
    handleViolation('Window lost focus', 'WINDOW_BLUR'); 
  }
});

// DETECT FULLSCREEN EXIT
document.addEventListener('fullscreenchange', () => {
  if (isExamActive && !inFullscreen()) {
    handleViolation('Fullscreen exited - this is a violation', 'FULLSCREEN_EXIT');
    // Try to restore fullscreen
    setTimeout(() => {
      if (isExamActive && !inFullscreen()) {
        try {
          requestFullscreen();
          console.log('[Fullscreen] Attempting to restore fullscreen...');
        } catch(e) {
          console.warn('[Fullscreen] Cannot restore fullscreen:', e);
        }
      }
    }, 500);
  }
});

document.addEventListener('webkitfullscreenchange', () => {
  if (isExamActive && !inFullscreen()) {
    handleViolation('Fullscreen exited - this is a violation', 'FULLSCREEN_EXIT');
  }
});

document.addEventListener('mozfullscreenchange', () => {
  if (isExamActive && !inFullscreen()) {
    handleViolation('Fullscreen exited - this is a violation', 'FULLSCREEN_EXIT');
  }
});

document.addEventListener('msfullscreenchange', () => {
  if (isExamActive && !inFullscreen()) {
    handleViolation('Fullscreen exited - this is a violation', 'FULLSCREEN_EXIT');
  }
});

// PREVENT RIGHT-CLICK (except on input fields)
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (isExamActive) {
    e.preventDefault();
    handleViolation('Right-click blocked', 'RIGHT_CLICK');
  }
});

// BACK BUTTON GUARD
let popStateGuardInstalled = false;
function installBackButtonGuard() {
  if (popStateGuardInstalled) return;
  try {
    history.pushState({ exam: 'running' }, document.title, location.href);
    popStateGuardInstalled = true;
  } catch (e) {
    popStateGuardInstalled = false;
  }

  window.addEventListener('popstate', (ev) => {
    if (!isExamActive) return;
    window._lastPopStateWasBackNav = true;
    handleViolation('Back navigation detected: leaving the exam will be counted as a behavior warning.', 'BACK_NAVIGATION');
    try { history.pushState({ exam: 'running' }, document.title, location.href); } catch(e){}
  });
}

// PREVENT TEXT SELECTION (except in input fields)
document.addEventListener('selectstart', (e) => { 
  const t = e.target; 
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; 
  if (isExamActive) e.preventDefault(); 
});

// DETECT SCREENSHOT ATTEMPTS
document.addEventListener('keydown', (e) => {
  if (!isExamActive) return;
  const k = e.key.toLowerCase();
  
  if (k === 'printscreen') { 
    handleViolation('Screenshot detected', 'SCREENSHOT_ATTEMPT'); 
  }
  
  if ((e.ctrlKey && e.key === 's') || (e.ctrlKey && e.key === 'p')) { 
    e.preventDefault(); 
  }
});

// DETECT SIGNIFICANT WINDOW RESIZE (desktop only)
let lastSize = { w: window.innerWidth, h: window.innerHeight };
window.addEventListener('resize', () => {
  if (IS_MOBILE_DEVICE) return;
  
  const w = window.innerWidth, h = window.innerHeight;
  const dw = Math.abs(w - lastSize.w), dh = Math.abs(h - lastSize.h);
  lastSize = { w, h };
  
  if (isExamActive && (dw > 200 || dh > 200)) {
    handleViolation('Screen size changed: this is considered a violation.', 'SCREEN_RESIZE');
  }
});

/* ========== MODAL BUTTONS ========== */
const continueBtn = document.getElementById('continueBtn');
const exitBtn = document.getElementById('exitBtn');

if (continueBtn) {
  continueBtn.addEventListener('click', async () => {
    if (warningCountdownInterval) { 
      clearInterval(warningCountdownInterval); 
      warningCountdownInterval = null; 
    }
    warningCountdownRemaining = 0;
    if (warningModal) warningModal.hide();
    
    // FORCE FULLSCREEN ON CONTINUE
    try { 
      await requestFullscreen(); 
      console.log('[Fullscreen] Restored on Continue button');
    } catch (e) { 
      console.warn('[Fullscreen] Failed to restore:', e); 
    }
    
    setTimeout(() => { 
      if (window._lastPopStateWasBackNav) {
        try { history.pushState({ exam: 'running' }, document.title, location.href); } catch(e){}
        window._lastPopStateWasBackNav = false;
      }
      
      try {
        const rs = sessionStorage.getItem('exam_runtime_state_v1');
        if (rs && !isExamActive) {
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
      } catch (e) {}
      
      violationLock = false;
    }, 150);
  });
}

if (exitBtn) {
  exitBtn.addEventListener('click', () => {
    if (warningModal) warningModal.hide();
    userInfo.violated = true;
    finishExam('Student chose to exit during violation warning');
  });
}
