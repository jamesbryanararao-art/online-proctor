// login.js - handles the login/enter-exam flow, duplicate check, instructions modal, and connectivity checks
document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn');
  const startLoading = document.getElementById('startLoadingSpinner');
  const instructionModal = new bootstrap.Modal(document.getElementById('instructionModal'));
  const noInternetModal = new bootstrap.Modal(document.getElementById('noInternetModal'));

  function isOnline() { return navigator.onLine; }

  window.addEventListener('online', () => { if (noInternetModal) noInternetModal.hide(); });
  window.addEventListener('offline', () => { if (noInternetModal) noInternetModal.show(); });

  startBtn.addEventListener('click', async () => {
    const lastName = document.getElementById('lastName').value.trim();
    const firstName = document.getElementById('firstName').value.trim();
    const code = document.getElementById('code').value.trim();

    if (!lastName || !firstName || !code) {
      alert('Please fill in all fields.');
      return;
    }

    if (!isOnline()) {
      noInternetModal.show();
      return;
    }

    // Disable and hide button immediately to prevent multiple clicks
    startBtn.disabled = true;
    startBtn.style.display = 'none';
    
    // Show loading while checking duplicate and fetching instructions
    startLoading.classList.add('show');

    try {
      const api = window.ANSWER_API_URL || ''; // optional global fallback
      // Basic duplicate check via API if available
      let dupExists = false;
      if (api) {
        const url = `${api}?action=checkDuplicate&lastName=${encodeURIComponent(lastName)}&firstName=${encodeURIComponent(firstName)}&code=${encodeURIComponent(code)}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          dupExists = !!data.exists;
        }
      }

      if (dupExists) {
        alert('Duplicate record exists. Please contact your instructor.');
        startLoading.classList.remove('show');
        // Re-enable button for retry
        startBtn.disabled = false;
        startBtn.style.display = '';
        return;
      }

      // Load instructions if available from sheet via API
      let instructions = 'Everyone is presumed innocent until proven guilty, and no one is required to testify against themselves. Please read all instructions carefully.';
      if (api) {
        try {
          const insRes = await fetch(`${api}?action=getInstructions&code=${encodeURIComponent(code)}`);
          if (insRes.ok) {
            const json = await insRes.json();
            if (json.instructions) instructions = json.instructions;
          }
        } catch (e) { /* ignore instruction fetch errors */ }
      }

      document.getElementById('instructionsText').textContent = instructions;
      startLoading.classList.remove('show');
      instructionModal.show();

      // Re-enable button if user closes modal without clicking Agree
      const modalElement = document.getElementById('instructionModal');
      const handleModalHide = () => {
        startBtn.disabled = false;
        startBtn.style.display = '';
        modalElement.removeEventListener('hidden.bs.modal', handleModalHide);
      };
      modalElement.addEventListener('hidden.bs.modal', handleModalHide);

      document.getElementById('agreeBtn').onclick = async () => {
        // Remove the hide listener since user clicked Agree (button should stay hidden)
        modalElement.removeEventListener('hidden.bs.modal', handleModalHide);
        instructionModal.hide();
        // Show the loader and ensure the UI shows an animation for at least 5s while we prefetch
        try { if (startLoading) startLoading.classList.add('show'); } catch (e){}
        const params = new URLSearchParams({ lastName, firstName, code: code.toUpperCase() });
        const examUrl = `${window.ANSWER_API_URL || ''}?action=getAllQuestionsAndAnswers&code=${encodeURIComponent(code.toUpperCase())}`;
        const t0 = Date.now();
        try {
          if (window.fetch && window.ANSWER_API_URL) {
            const res = await fetch(examUrl);
            if (res.ok) {
              const data = await res.json();
              try { sessionStorage.setItem('exam_last_server_payload', JSON.stringify(data)); } catch(e){}
            }
          }
        } catch (e) { console.warn('Prefetch failed', e); }
        // keep loader visible for at least 5 seconds to avoid abrupt transition
        const elapsed = Date.now() - t0;
        const wait = Math.max(0, 5000 - elapsed);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try { if (startLoading) startLoading.classList.remove('show'); } catch (e){}
        // Redirect to exam page (exam will prefer prefetched payload)
        location.href = `exam.html?${params.toString()}`;
      };

    } catch (err) {
      console.error('Login start error', err);
      startLoading.classList.remove('show');
      // Re-enable button for retry
      startBtn.disabled = false;
      startBtn.style.display = '';
      alert('Connection error. Please check your internet and try again.');
    }
  });
});
