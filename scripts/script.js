/* ------------------ Complete JavaScript Script (Batch Questions/Answers from Sheet + Dynamic Rendering) ------------------ */

// Bootstrap Modal Instances
const warningModal = new bootstrap.Modal(document.getElementById('warningModal'));
const confirmModal = new bootstrap.Modal(document.getElementById('confirmModal'));
const duplicateModal = new bootstrap.Modal(document.getElementById('duplicateModal'));
const errorModal = new bootstrap.Modal(document.getElementById('errorModal'));

let confirmOpen = false;
let confirmCallback = null;

/* ------------------ Exam Guardrails ------------------ */
// Block reload/inspect/common shortcuts
document.addEventListener("keydown", function(e) {
  const k = e.key?.toLowerCase?.() || "";
  if (e.key === "F5" || (e.ctrlKey && k === "r")) { e.preventDefault(); }
  if (e.key === "F12" || (e.ctrlKey && e.shiftKey && (k === "i" || k === "j"))) { e.preventDefault(); }
  if (e.ctrlKey && ["c", "v", "x", "a", "s", "u"].includes(k)) { e.preventDefault(); }
});
// Disable right click
document.addEventListener("contextmenu", e => e.preventDefault());

/* ------------------ Fullscreen Helpers ------------------ */
function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  if (el.msRequestFullscreen) return el.msRequestFullscreen();
}

function inFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement ||
            document.mozFullScreenElement || document.msFullscreenElement);
}

/* ------------------ Exam State ------------------ */
let questions = []; // Array of {code, question, answer} objects (dynamic from sheet)
let answersMap = {}; // {code: answer} for instant lookups
let userAnswers = {}; // Changed to object: {qCode: userAnswer} for JSON submission
let score = 0;
let current = 0;
let timer;
let remaining = 30; // 30 seconds per question
let examTimerSeconds = 30;
let userInfo = { lastName: '', firstName: '', code: '', startTime: '', endTime: '', date: '' }; // Removed email, teacher, subject, schedule

// Replace this with your actual Google Apps Script Web App URL
const ANSWER_API_URL = "https://script.google.com/macros/s/AKfycby6B9OgDmMNJqGmDNBvF7MJnAaV1wXTnvmzjjCEqn8vIh1zEFx7Izn3jxEJIsvnuXF4/exec";

let tabWarnings = 0;
let isExamActive = false;
let violationLock = false; 

const quizDiv = document.getElementById("quiz");
const progressEl = document.getElementById("progress");
const timerEl = document.getElementById("timer");
const resultEl = document.getElementById("result");
const startBtn = document.getElementById("startBtn");
const startCard = document.getElementById("startCard");
const loadingSpinner = document.getElementById("loadingSpinner");

/* ------------------ Timer Functions ------------------ */
function formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return m + ":" + sec;
}

function startTimer() {
  clearInterval(timer);
 const currentQ = questions[current];
 remaining = currentQ ? (currentQ.timerSeconds || examTimerSeconds) : examTimerSeconds;
     
  updateHud("timer", "Time: " + formatTime(remaining));
  timer = setInterval(() => {
    remaining--;
    updateHud("timer", "Time: " + formatTime(remaining));
    if (remaining <= 0) {
      clearInterval(timer);
      autoSubmitAnswer();
    }
  }, 1000);
}

function autoSubmitAnswer() {
  const ansInput = document.getElementById("ansInput");
  const ans = ansInput ? ansInput.value.trim() || "-" : "-";
  const q = questions[current]; // Get current q for code
  if (q) {
    userAnswers[q.code] = ans; // Use code as key
  }
  submitAnswer(ans);
}

/* ------------------ HUD Update with Animation ------------------ */
function updateHud(elementId, text) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = text;
    el.classList.add("updated");
    setTimeout(() => el.classList.remove("updated"), 600);
  }
}

// NEW: Global Enter handler for submit (robustness - catches Enter anywhere during exam)
function globalEnterHandler(e) {
  if (e.key === "Enter" && isExamActive && !confirmOpen) {
    e.preventDefault();
    const ansInput = document.getElementById("ansInput");
    if (ansInput) {
      const ans = ansInput.value.trim() || "-";
      showConfirmModal(ans, () => submitAnswer(ans));
    }
  }
}

/* ------------------ Render Question with Fade-In Animation (Dynamic) ------------------ */
/* ------------------ Render Question with Fade-In Animation (Dynamic) ------------------ */
function renderQuestion(index) {
  quizDiv.innerHTML = "";
  const q = questions[index];
  if (!q) return; // Safety check
  updateHud("progress", `Question ${index + 1}/${questions.length}`);

  const card = document.createElement("div");
  card.className = "card card-custom mx-auto fade-in";

  // NEW: Create question div separately to support HTML (<br> for line breaks/formatting)
  const questionDiv = document.createElement("div");
  questionDiv.className = "question-text";
  questionDiv.innerHTML = q.question; // Use innerHTML to render <br> as newlines (e.g., options)

  card.innerHTML = `
    <div class="card-body p-4">
       ${questionDiv.outerHTML}
       <input type="text" class="form-control answer-input" id="ansInput" autocomplete="off" autofocus placeholder="Enter answer in CAPS (e.g., B for option b)" style="resize: vertical; transition: border-color 0.3s;"> 
       <button class="btn btn-accent mt-3 w-100" id="submitBtn">Submit</button> 
     </div>
  `;
  quizDiv.appendChild(card);

  // Trigger fade-in animation
  setTimeout(() => card.classList.add("show"), 10);

  startTimer(); // start/reset timer for this question
  if (current === 0) { // Only on first question
     updateHud("timer", `Time: ${formatTime(examTimerSeconds)} per question`);
   }

  // NEW: Enhanced direct focus - select text, highlight input briefly (no click needed)
  const ansInput = document.getElementById("ansInput");
  if (ansInput) {
    setTimeout(() => { // Slight delay to ensure DOM ready
      ansInput.focus();
      ansInput.select(); // Select any text (ready to overwrite/type)
      // Brief visual highlight to draw attention
      ansInput.classList.add("focus-highlight");
      setTimeout(() => ansInput.classList.remove("focus-highlight"), 1000);
    }, 100);
  }

  const submit = () => {
    const ans = document.getElementById("ansInput").value.trim() || "-";
    showConfirmModal(ans, () => submitAnswer(ans));
  };

  document.getElementById("submitBtn").addEventListener("click", submit, {once: true});
  document.getElementById("ansInput").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (confirmOpen) return; // ignore Enter if confirm is open
      submit();
    }
  }, {once: true});
}

/* ------------------ Submit Answer (Instant from Batch Map) ------------------ */
function submitAnswer(userAnswer) {
  clearInterval(timer); // stop timer on submit

  const q = questions[current];
  if (!q) return;

  const correctAnswer = answersMap[q.code] || ""; // Instant lookup from batch

  userAnswers[q.code] = userAnswer; // Use q.code as key (object)
  try { localStorage.setItem('exam_user_answers_v1', JSON.stringify(userAnswers)); } catch (e) {}

  if (userAnswer.toLowerCase() === correctAnswer.toLowerCase()) {
    score++;
  }

  current++;
  if (current < questions.length) {
    renderQuestion(current);
  } else {
    finishExam();
  }
}

/* ------------------ Batch Fetch Questions and Answers from Sheet ------------------ */
async function fetchAllQuestionsAndAnswers() {
  try {
    const res = await fetch(`${ANSWER_API_URL}?action=getAllQuestionsAndAnswers&code=${encodeURIComponent(userInfo.code)}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: Failed to connect to backend. Check web app deployment.`);
    }
    const response = await res.json();
    const questionsMap = response.questionsMap || {};
    examTimerSeconds = response.defaultTimerSeconds || 30;
    
    // Check for backend error
    if (response.error) {
      throw new Error(`Backend Error: ${response.error}`);
    }
    
    if (Object.keys(questionsMap).length === 0) {
      throw new Error("No questions found. Check sheet '" + userInfo.code + "' has data in columns A-D (Code, Question, Answer, Timer).");
    }

    questions = shuffleArray(Object.values(questionsMap));
    answersMap = Object.fromEntries(questions.map(q => [q.code, q.answer]));
    // Persist questions and answers for offline/reliability
    try {
      localStorage.setItem('exam_questions_v1', JSON.stringify(questions));
      localStorage.setItem('exam_answers_map_v1', JSON.stringify(answersMap));
    } catch (e) { console.warn('Persist QA failed', e); }
    
    console.log(`Batch loaded: ${questions.length} questions from sheet "${userInfo.code}" with ${examTimerSeconds}s timer`);
    return true;
  } catch (err) {
    console.error("Batch fetch failed:", err);
    
    // Show detailed error modal
    let errorMsg = err.message || "Unknown error loading questions.";
    if (errorMsg.includes("HTTP")) {
      errorMsg = "Connection failed: Verify the web app URL and redeploy Apps Script.";
    } else if (errorMsg.includes("Sheet not found")) {
      errorMsg = "Sheet not found: Ensure '" + userInfo.code + "' tab exists in the Google Sheet bound to Apps Script.";
    } else if (errorMsg.includes("No questions")) {
      errorMsg = "No questions loaded: Verify A-D columns in sheet '" + userInfo.code + "' (Row 1: Headers, Rows 2+: Questions until blank A).";
    }
    
    document.getElementById("errorText").innerHTML = `
      <strong>Quiz Loading Error:</strong><br>
      ${errorMsg}<br><br>
      <small>Console logs: ${err.message}. Contact teacher if persists.</small>
    `;
    errorModal.show();
    
    // Reset state
    isExamActive = false;
    startCard.style.display = "block";
    resultEl.textContent = "Enter your details to begin the exam.";
    loadingSpinner.classList.add("d-none");
    
    return false;
  }
}

/* ------------------ Confirm Modal (Bootstrap) ------------------ */
function showConfirmModal(answer, onConfirm) {
  document.getElementById("confirmText").textContent = `Are you sure you want to submit "${answer}" as your final answer?`;
  confirmModal.show();
  confirmOpen = true;
  confirmCallback = onConfirm;

  // Handle keys for modal (capture phase)
  const handleKeys = (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleYes(); }
    if (e.key === "Escape") { e.preventDefault(); handleNo(); }
  };
  document.addEventListener("keydown", handleKeys, true);

  function handleYes() {
    confirmModal.hide();
    confirmOpen = false;
    document.removeEventListener("keydown", handleKeys, true);
    if (confirmCallback) confirmCallback();
  }

  function handleNo() {
    confirmModal.hide();
    confirmOpen = false;
    document.removeEventListener("keydown", handleKeys, true);
  }

  // Event listeners for buttons (remove on hide to avoid duplicates)
  const confirmYesBtn = document.getElementById("confirmYes");
  const confirmNoBtn = document.getElementById("confirmNo");
  confirmYesBtn.onclick = handleYes;
  confirmNoBtn.onclick = handleNo;

  // Clean up on modal hide
  confirmModal._element.addEventListener('hidden.bs.modal', () => {
    confirmOpen = false;
    document.removeEventListener("keydown", handleKeys, true);
    confirmYesBtn.onclick = null;
    confirmNoBtn.onclick = null;
  }, { once: true });
}

/* ------------------ Finish Exam & Record Grade (with Fade-In) ------------------ */
async function finishExam() {
  clearInterval(timer);
  isExamActive = false;
  document.removeEventListener("keydown", globalEnterHandler);
  quizDiv.innerHTML = "";
  updateHud("progress", "Exam Completed");
  resultEl.textContent = "Exam Finished";

  const finalScore = `${score}/${questions.length}`;
  const resultsCard = document.createElement("div");
  resultsCard.className = "card card-custom mx-auto fade-in";
  resultsCard.style.maxWidth = "600px";
  resultsCard.innerHTML = `
    <div class="card-body text-center">
      <h2 class="card-title">Exam Results</h2>
  <h3 class="text-primary">Results recorded</h3>
      <div id="countdownBox" class="mt-3 fs-6 text-muted">
        After 300s, this will go back to the start page.
      </div>
    </div>
  `;
  quizDiv.appendChild(resultsCard);

  // Trigger fade-in
  setTimeout(() => resultsCard.classList.add("show"), 10);

       // FIXED: Record grade via POST (handles long JSON); add UI confirmation above results
     userInfo.endTime = new Date().toISOString();
     userInfo.date = userInfo.endTime.split('T')[0]; // Consistent date from endTime
     const submittedAnswersJson = JSON.stringify(userAnswers); // {qCode: ans} for backend processing

     // Create confirmation div (will be inserted above score)
     const confirmationDiv = document.createElement('div');
     confirmationDiv.id = 'submissionStatus';
     confirmationDiv.className = 'mb-3 p-2 rounded'; // Bootstrap styling
     confirmationDiv.style.fontWeight = 'bold';

     // Compute correct and mistakes lists client-side and submit to F..M via recordResultsFM
     const correctList = [];
     const mistakesList = [];
     Object.keys(answersMap || {}).forEach(c => {
       const ua = String((userAnswers || {})[c] || '').trim();
       const ca = String((answersMap || {})[c] || '').trim();
       if (!ua) return;
       if (ua && ca && ua.toLowerCase() === ca.toLowerCase()) correctList.push(`${c} ${ua}`);
       else if (ua && ua !== '-') mistakesList.push(`${c} ${ua}`);
     });

     const fmPayload = {
       action: 'recordResultsFM',
       lastName: userInfo.lastName,
       firstName: userInfo.firstName,
       code: userInfo.code,
       score: finalScore,
       correct: correctList.join(', '),
       mistakes: mistakesList.join(', '),
       startTime: userInfo.startTime,
       endTime: userInfo.endTime,
       date: userInfo.date
     };

     // Force immediate submission with continuous retry until success
     async function postWithRetry() {
       const scoreEl = resultsCard.querySelector('h3');
       while (true) {
         if (!navigator.onLine) {
           confirmationDiv.textContent = 'Waiting for internet connection...';
           confirmationDiv.className = 'mb-3 p-2 rounded bg-warning text-dark';
           if (scoreEl) scoreEl.parentNode.insertBefore(confirmationDiv, scoreEl);
           await new Promise(r => setTimeout(r, 1500));
           continue;
         }
         try {
           const res = await fetch(ANSWER_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fmPayload) });
           const data = await res.json().catch(() => ({}));
           if (res.ok && data && data.success) {
             confirmationDiv.textContent = '✓ Results submitted.';
             confirmationDiv.className = 'mb-3 p-2 rounded bg-success text-white';
             try { localStorage.setItem('exam_submission_status_v1', 'submitted'); } catch (e) {}
             if (scoreEl) scoreEl.parentNode.insertBefore(confirmationDiv, scoreEl);
             return;
           }
           confirmationDiv.textContent = 'Server error, retrying...';
           confirmationDiv.className = 'mb-3 p-2 rounded bg-warning text-dark';
           if (scoreEl) scoreEl.parentNode.insertBefore(confirmationDiv, scoreEl);
         } catch (err) {
           confirmationDiv.textContent = 'Network error, retrying...';
           confirmationDiv.className = 'mb-3 p-2 rounded bg-warning text-dark';
           if (scoreEl) scoreEl.parentNode.insertBefore(confirmationDiv, scoreEl);
         }
         await new Promise(r => setTimeout(r, 1500));
       }
     }
     await postWithRetry();
     

  // 5-minute countdown to reset
  let countdown = 300;
  const cdEl = document.getElementById("countdownBox");
  const interval = setInterval(() => {
    countdown--;
    cdEl.textContent = `After ${countdown}s, this will go back to the start page.`;
    if (countdown <= 0) {
      clearInterval(interval);
      resetExam();
    }
  }, 1000);
}

/* ------------------ Reset Exam (with Fade-Out) ------------------ */
function resetExam() {
  // Fade out quiz area
  quizDiv.style.opacity = "0";
  quizDiv.style.transition = "opacity 0.5s ease";
  setTimeout(() => {
    quizDiv.innerHTML = "";
    quizDiv.style.opacity = "1";
    // NEW: Ensure global Enter listener is removed
    document.removeEventListener("keydown", globalEnterHandler);
    resultEl.textContent = "Enter your details to begin the exam.";
    startBtn.style.display = "block";
    startCard.style.display = "block";
    updateHud("progress", "Question 0/0");
    updateHud("timer", "Time: 00:30");
    score = 0;
    current = 0;
    userAnswers = {}; // Reset to empty object
    remaining = 30;
    tabWarnings = 0;
    violationLock = false;
    isExamActive = false;
    questions = [];
    answersMap = {}; // Clear batch data
    examTimerSeconds = 30; 
    document.body.style.background = ""; // Reset if needed
  }, 500);
}

/* ------------------ Violation Handling ------------------ */
function handleViolation() {
  if (!isExamActive || violationLock) return;
  violationLock = true;

  tabWarnings++;

  if (tabWarnings === 1) {
    // First offense: show modal + auto resume after 8s
    document.getElementById("warningText").textContent = "This is your first warning. Resuming exam in 8s...";
    warningModal.show();

    let autoResume = 8;
    const interval = setInterval(() => {
      autoResume--;
      document.getElementById("warningText").textContent = `Resuming exam in ${autoResume}s...`;
      if (autoResume <= 0) {
        clearInterval(interval);
        warningModal.hide();
        requestFullscreen().catch(() => {});
        setTimeout(() => { violationLock = false; }, 150);
      }
    }, 1000);
  } else {
    // Second offense: end exam
    document.body.style.background = "red";
    warningModal.hide();
    finishExam();
    violationLock = false;
  }
}

// Visibility change (tab switch / minimize)
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { handleViolation(); }
});

// Exit fullscreen = violation
document.addEventListener("fullscreenchange", () => {
  if (isExamActive && !inFullscreen()) { handleViolation(); }
});
document.addEventListener("webkitfullscreenchange", () => {
  if (isExamActive && !inFullscreen()) { handleViolation(); }
});
document.addEventListener("msfullscreenchange", () => {
  if (isExamActive && !inFullscreen()) { handleViolation(); }
});

/* ------------------ Modal Event Listeners ------------------ */
// Warning Modal Buttons
document.getElementById("continueBtn").addEventListener("click", async () => {
  warningModal.hide();
  try { await requestFullscreen(); } catch (e) {}
  setTimeout(() => { violationLock = false; }, 150);
});

document.getElementById("exitBtn").addEventListener("click", () => {
  warningModal.hide();
  finishExam();
  violationLock = false;
});

// Duplicate Modal Button
document.getElementById("duplicateOk").addEventListener("click", () => {
  duplicateModal.hide();
});

// Error Modal Button
document.getElementById("errorOk").addEventListener("click", () => {
  errorModal.hide();
  // Optional: Reset form or log
  console.log("Error modal closed – user can retry.");
});


/* ------------------ Start Exam with Validation + Batch Load + Loading Animation ------------------ */
startBtn.addEventListener("click", async () => {
  const lastName = document.getElementById("lastName").value.trim();
  const firstName = document.getElementById("firstName").value.trim();
  const code = document.getElementById("code").value.trim();

  // Client-side validation (only 3 fields required)
  if (!lastName || !firstName || !code) {
    alert("Please fill in all fields: Last Name, First Name, and Test Code.");
    return;
  }
  if (code.length < 3) {
    alert("Test Code must be at least 3 characters (e.g., TEST001).");
    return;
  }

  // Store user info (simplified)
  userInfo.lastName = lastName;
  userInfo.firstName = firstName;
  userInfo.code = code.toUpperCase();
  userInfo.startTime = new Date().toISOString();
  userInfo.date = new Date().toISOString().split('T')[0];

  // Check for duplicate
  const checkUrl = `${ANSWER_API_URL}?action=checkDuplicate&lastName=${encodeURIComponent(lastName)}&firstName=${encodeURIComponent(firstName)}&code=${encodeURIComponent(userInfo.code)}`;

  try {
    const res = await fetch(checkUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: Connection issue – check web app deployment.`);
    }
    const data = await res.json();

    if (data.exists) {
      document.getElementById("duplicateText").textContent = `A record for "${firstName} ${lastName}" already exists in test "${userInfo.code}". Please contact your instructor.`;
      duplicateModal.show();
      return;
    }

    // No duplicate: Proceed, show spinner
    try { await requestFullscreen(); } catch (e) {}
    startCard.style.display = "none";
    resultEl.textContent = "Exam in progress...";
    isExamActive = true;

    // Show loading spinner with dynamic message
    document.getElementById("loadingCode").textContent = userInfo.code;
    loadingSpinner.classList.remove("d-none"); // Show spinner

    // Batch load questions
    const batchSuccess = await fetchAllQuestionsAndAnswers();

    // Hide spinner
    loadingSpinner.classList.add("d-none");

    if (batchSuccess && questions.length > 0) {
      current = 0;
      score = 0;
      userAnswers = {};
      document.addEventListener("keydown", globalEnterHandler);
      renderQuestion(0);
    } else {
      // Error already handled in fetchAllQuestionsAndAnswers (modal shown)
    }
  } catch (err) {
    // Connection/duplicate check error
    console.error("Start error:", err);
    document.getElementById("errorText").innerHTML = `
      <strong>Connection or Validation Error:</strong><br>
      ${err.message}<br><br>
      <small>Check: Internet connection, web app URL in script.js, or contact admin.</small>
    `;
    errorModal.show();
    // Reset
    isExamActive = false;
    startCard.style.display = "block";
    resultEl.textContent = "Enter your details to begin the exam.";
    loadingSpinner.classList.add("d-none");
  }
});

/* ------------------ Utility Functions ------------------ */
function shuffleArray(arr) {
  // Fisher-Yates shuffle for randomization (unchanged from original)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
