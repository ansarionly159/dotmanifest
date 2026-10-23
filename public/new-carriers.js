// Dotmanifest — New Carrier Manifest page (new-carriers.html): account + date search.

let currentTier = 'free';
let authToken = localStorage.getItem('dm_token') || '';

const form = document.getElementById('searchForm');
const singleField = document.getElementById('singleField');
const startField = document.getElementById('startField');
const endField = document.getElementById('endField');
const resultsBody = document.getElementById('resultsBody');
const resultCount = document.getElementById('resultCount');
const upgradeOverlay = document.getElementById('upgradeOverlay');
const exportBtn = document.getElementById('exportBtn');

const accountStatus = document.getElementById('accountStatus');
const openAuthBtn = document.getElementById('openAuthBtn');
const openAuthBtn2 = document.getElementById('openAuthBtn2');
const logoutBtn = document.getElementById('logoutBtn');
const authModal = document.getElementById('authModal');
const closeAuthBtn = document.getElementById('closeAuthBtn');
const showLoginBtn = document.getElementById('showLoginBtn');
const showSignupBtn = document.getElementById('showSignupBtn');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const loginError = document.getElementById('loginError');
const signupError = document.getElementById('signupError');

function openAuth() { authModal.classList.remove('hidden'); }
function closeAuth() { authModal.classList.add('hidden'); }
openAuthBtn.addEventListener('click', openAuth);
if (openAuthBtn2) openAuthBtn2.addEventListener('click', openAuth);
closeAuthBtn.addEventListener('click', closeAuth);

showLoginBtn.addEventListener('click', () => {
  showLoginBtn.classList.add('active');
  showSignupBtn.classList.remove('active');
  loginForm.classList.remove('hidden');
  signupForm.classList.add('hidden');
});
showSignupBtn.addEventListener('click', () => {
  showSignupBtn.classList.add('active');
  showLoginBtn.classList.remove('active');
  signupForm.classList.remove('hidden');
  loginForm.classList.add('hidden');
});

signupForm.addEventListener('submit', async e => {
  e.preventDefault();
  signupError.textContent = '';
  const email = document.getElementById('signupEmail').value;
  const password = document.getElementById('signupPassword').value;
  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) { signupError.textContent = data.error; return; }
  authToken = data.token;
  localStorage.setItem('dm_token', authToken);
  closeAuth();
  refreshAccountStatus();
  runSearch();
});

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  loginError.textContent = '';
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) { loginError.textContent = data.error; return; }
  authToken = data.token;
  localStorage.setItem('dm_token', authToken);
  closeAuth();
  refreshAccountStatus();
  runSearch();
});

logoutBtn.addEventListener('click', () => {
  authToken = '';
  localStorage.removeItem('dm_token');
  refreshAccountStatus();
  runSearch();
});

async function refreshAccountStatus() {
  if (!authToken) {
    currentTier = 'free';
    accountStatus.textContent = 'Not logged in';
    openAuthBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    return;
  }
  const res = await fetch(`/api/me?token=${encodeURIComponent(authToken)}`);
  const data = await res.json();
  currentTier = data.tier;
  accountStatus.textContent = currentTier === 'paid' ? 'Premium account' : 'Free account';
  openAuthBtn.classList.add('hidden');
  logoutBtn.classList.remove('hidden');
}

document.querySelectorAll('input[name="mode"]').forEach(radio => {
  radio.addEventListener('change', e => {
    const isRange = e.target.value === 'range';
    singleField.classList.toggle('hidden', isRange);
    startField.classList.toggle('hidden', !isRange);
    endField.classList.toggle('hidden', !isRange);
  });
});

function currentParams() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const params = new URLSearchParams();
  if (authToken) params.set('token', authToken);
  if (mode === 'single') {
    params.set('date', document.getElementById('date').value);
  } else {
    params.set('start', document.getElementById('start').value);
    params.set('end', document.getElementById('end').value);
  }
  return params;
}

async function runSearch() {
  const params = currentParams();
  const res = await fetch(`/api/carriers?${params.toString()}`);
  const data = await res.json();
  currentTier = data.tier;
  render(data);
}

function render(data) {
  resultCount.textContent = `${data.count} carrier${data.count === 1 ? '' : 's'} found`;
  resultsBody.innerHTML = data.results.map(r => `
    <tr class="${r.locked ? 'locked' : ''}">
      <td>${r.company_name}</td>
      <td>${r.phone}</td>
      <td>${r.email || '—'}</td>
      <td>${r.dot_number}</td>
      <td>${r.mc_number}</td>
      <td>${r.city}, ${r.state}</td>
      <td class="${r.status === 'Active' ? 'status-active' : 'status-pending'}">${r.status}</td>
      <td>${r.equipment_count}</td>
      <td>${r.registration_date}</td>
    </tr>
  `).join('');

  const hasLocked = data.results.some(r => r.locked);
  upgradeOverlay.classList.toggle('hidden', !hasLocked);
  exportBtn.disabled = currentTier !== 'paid';
}

form.addEventListener('submit', e => {
  e.preventDefault();
  runSearch();
});

exportBtn.addEventListener('click', () => {
  const params = currentParams();
  window.location.href = `/api/export?${params.toString()}`;
});

refreshAccountStatus().then(runSearch);
